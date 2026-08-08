import { Hono } from 'hono'
import { z } from 'zod'
import type { AppConfig } from './config.js'
import { type AgentInfoResolver, createAgentInfoResolver } from './core/agent-info.js'
import { attributedBody } from './core/attribution.js'
import type { IdempotencyStore } from './core/idempotency.js'
import { badRequest, forbidden, HttpProblem } from './core/problem.js'
import type { RealmrootAuthenticator } from './core/realmroot-auth.js'
import { createGitHubProvider } from './providers/github/client.js'
import { githubManifest } from './providers/github/manifest.js'
import { adapterApiVersion, githubOpenApi, githubScopes } from './providers/github/openapi.js'
import type { GitHubProvider } from './providers/github/types.js'

type Variables = { requestId: string }
const issueInputSchema = z
  .object({ title: z.string().trim().min(1).max(256), body: z.string().max(65_536).optional() })
  .strict()
const paginationSchema = z.object({
  page: z.coerce.number().int().min(1).default(1),
  perPage: z.coerce.number().int().min(1).max(100).default(30),
})

export type AppDependencies = {
  authenticator: RealmrootAuthenticator
  agentInfo?: AgentInfoResolver
  github?: GitHubProvider
  idempotency: IdempotencyStore
  audit?: (record: Record<string, unknown>) => Promise<void>
}

export function createApp(config: AppConfig, dependencies: AppDependencies) {
  const app = new Hono<{ Variables: Variables }>()
  const authenticator = dependencies.authenticator
  const agentInfo = dependencies.agentInfo ?? createAgentInfoResolver(fetch, config.realmrootAgentInfoEndpoint)
  const github = dependencies.github ?? configuredGitHub(config)
  const idempotency = dependencies.idempotency
  const audit =
    dependencies.audit ??
    (async (record) => {
      console.info(JSON.stringify(record))
    })

  app.use('*', async (c, next) => {
    c.set('requestId', crypto.randomUUID())
    await next()
    c.header('Request-Id', c.get('requestId'))
  })

  app.get('/health', (c) => c.json({ status: 'ok' }))
  app.get('/providers/github/manifest', (c) => c.json(githubManifest))

  app.get('/.well-known/oauth-protected-resource/github/installations/:installationId', (c) => {
    const resource = installationResource(config.origin, installationId(c.req.param('installationId')))
    return c.json({
      resource,
      authorization_servers: [config.realmrootIssuer],
      scopes_supported: githubScopes,
      bearer_methods_supported: ['header'],
    })
  })

  app.get('/github/installations/:installationId/openapi.json', (c) => {
    const id = installationId(c.req.param('installationId'))
    return c.json(
      githubOpenApi({
        resource: installationResource(config.origin, id),
        realmrootIssuer: config.realmrootIssuer,
        installationId: id,
      }),
      200,
      {
        'Content-Type': 'application/vnd.oai.openapi+json',
      },
    )
  })

  app.get('/github/installations/:installationId', (c) => {
    const id = installationId(c.req.param('installationId'))
    const resource = installationResource(config.origin, id)
    return c.json({ resource, serviceDescription: `${resource}/openapi.json`, identityLevel: 'brokered' }, 200, {
      Link: `<${resource}/openapi.json>; rel="service-desc"; type="application/vnd.oai.openapi+json"`,
    })
  })

  app.get('/github/installations/:installationId/repositories', async (c) => {
    requireApiVersion(c.req.header('API-Version'))
    const id = installationId(c.req.param('installationId'))
    const principal = await authenticator.authenticate(c.req.raw, installationResource(config.origin, id))
    requireScope(principal.scopes, 'github:metadata:read')
    const query = paginationSchema.parse(c.req.query())
    const result = await github.listRepositories(id, query.page, query.perPage)
    const hasMore = query.page * query.perPage < result.total
    if (hasMore) {
      const next = new URL(c.req.url)
      next.searchParams.set('page', String(query.page + 1))
      next.searchParams.set('perPage', String(query.perPage))
      c.header('Link', `<${next}>; rel="next"`)
    }
    c.header('API-Version', adapterApiVersion)
    c.header('Vary', 'API-Version')
    return c.json({
      items: result.items,
      pagination: { page: query.page, perPage: query.perPage, total: result.total, hasMore },
    })
  })

  app.post('/github/installations/:installationId/repos/:owner/:repository/issues', async (c) => {
    requireApiVersion(c.req.header('API-Version'))
    const id = installationId(c.req.param('installationId'))
    const principal = await authenticator.authenticate(c.req.raw, installationResource(config.origin, id))
    requireScope(principal.scopes, 'github:issues:write')
    const input = issueInputSchema.parse(await readJson(c.req.raw))
    const owner = c.req.param('owner')
    const repository = c.req.param('repository')
    const result = await idempotency.execute(
      c.req.header('Idempotency-Key') ?? null,
      `${principal.actor.issuer}:${principal.actor.subject}:${id}:${owner.toLowerCase()}/${repository.toLowerCase()}:create-issue`,
      input,
      async () => {
        const display = await agentInfo.resolve(principal)
        const issue = await github.createIssue({
          installationId: id,
          owner,
          repository,
          title: input.title,
          body: attributedBody(input.body, principal, display, c.get('requestId')),
        })
        await audit({
          event: 'provider.operation',
          requestId: c.get('requestId'),
          provider: 'github',
          operation: 'createIssue',
          installationId: id,
          repository: `${owner}/${repository}`,
          originatingPrincipal: { issuer: principal.actor.issuer, subject: principal.actor.subject },
          providerActor: { type: 'github_app', id: config.githubAppId ?? 'injected-test-provider' },
          identityLevel: 'brokered',
          result: { id: issue.id, url: issue.htmlUrl },
          occurredAt: new Date().toISOString(),
        })
        return Response.json(issue, { status: 201, headers: { Location: issue.htmlUrl } })
      },
    )
    c.header('API-Version', adapterApiVersion)
    c.header('Vary', 'API-Version')
    return result
  })

  app.notFound((c) =>
    problemResponse(
      new HttpProblem(404, 'about:blank', 'Not Found', 'The resource was not found.'),
      c.req.url,
      c.get('requestId'),
    ),
  )
  app.onError((error, c) => {
    const problem = normalizeProblem(error)
    return problemResponse(problem, c.req.url, c.get('requestId'))
  })
  return app
}

function configuredGitHub(config: AppConfig): GitHubProvider {
  if (!config.githubAppId || !config.githubPrivateKey) {
    return {
      listRepositories: async () => {
        throw new HttpProblem(
          503,
          'urn:realmroot:adapter:not-configured',
          'Service Unavailable',
          'GitHub App credentials are not configured.',
        )
      },
      createIssue: async () => {
        throw new HttpProblem(
          503,
          'urn:realmroot:adapter:not-configured',
          'Service Unavailable',
          'GitHub App credentials are not configured.',
        )
      },
    }
  }
  return createGitHubProvider({
    appId: config.githubAppId,
    privateKey: config.githubPrivateKey,
    apiOrigin: config.githubApiOrigin,
  })
}

function installationResource(origin: string, installationId: number) {
  return `${origin}/github/installations/${installationId}`
}

function installationId(value: string) {
  const parsed = Number(value)
  if (!Number.isSafeInteger(parsed) || parsed <= 0) throw badRequest('The GitHub installation ID is invalid.')
  return parsed
}

function requireApiVersion(value: string | undefined) {
  if (value !== adapterApiVersion)
    throw badRequest(`API-Version must be ${adapterApiVersion}.`, 'unsupported-api-version')
}

function requireScope(scopes: ReadonlySet<string>, required: string) {
  if (!scopes.has(required)) throw forbidden(`The ${required} scope is required.`)
}

async function readJson(request: Request) {
  try {
    return await request.json()
  } catch {
    throw badRequest('The request body must be valid JSON.')
  }
}

function normalizeProblem(error: unknown) {
  if (error instanceof HttpProblem) return error
  if (error instanceof z.ZodError) return badRequest(z.prettifyError(error))
  console.error(error)
  return new HttpProblem(500, 'about:blank', 'Internal Server Error', 'The adapter could not complete the request.')
}

function problemResponse(problem: HttpProblem, instance: string, requestId: string) {
  const headers = new Headers({
    'Content-Type': 'application/problem+json',
    'Request-Id': requestId,
    ...problem.headers,
  })
  return new Response(
    JSON.stringify({
      type: problem.type,
      title: problem.title,
      status: problem.status,
      detail: problem.message,
      instance,
    }),
    { status: problem.status, headers },
  )
}
