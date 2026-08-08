import { type Context, Hono } from 'hono'
import { z } from 'zod'
import type { AppConfig } from './config.js'
import { type AgentInfoResolver, createAgentInfoResolver } from './core/agent-info.js'
import { attributedBody } from './core/attribution.js'
import type { BrokeredConnectionRequest, BrokeredRevocationRequest } from './core/connection-request.js'
import type { IdempotencyStore } from './core/idempotency.js'
import { badRequest, forbidden, HttpProblem } from './core/problem.js'
import type { RealmrootAuthenticator } from './core/realmroot-auth.js'
import { createGitHubConnectionProvider, createGitHubProvider } from './providers/github/client.js'
import { githubManifest } from './providers/github/manifest.js'
import { adapterApiVersion, githubOpenApi, githubScopes } from './providers/github/openapi.js'
import type { GitHubConnectionProvider, GitHubProvider } from './providers/github/types.js'
import type { GitHubConnectionIntent, GitHubConnectionStore } from './storage/d1-github-connections.js'

type RequestFailure = { type: string; error?: { name: string; message: string; stack?: string } }
type Variables = { requestId: string; failure?: RequestFailure }
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
  audit: (record: Record<string, unknown>) => Promise<void>
  connectionRequestVerifier?: (request: string) => Promise<BrokeredConnectionRequest>
  revocationRequestVerifier?: (request: string) => Promise<BrokeredRevocationRequest>
  githubConnection?: GitHubConnectionProvider
  githubConnections?: GitHubConnectionStore
}

export function createApp(config: AppConfig, dependencies: AppDependencies) {
  const app = new Hono<{ Variables: Variables }>()
  const authenticator = dependencies.authenticator
  const agentInfo = dependencies.agentInfo ?? createAgentInfoResolver(fetch, config.realmrootAgentProfileUriTemplate)
  const github = dependencies.github ?? configuredGitHub(config)
  const githubConnection = dependencies.githubConnection ?? configuredGitHubConnection(config)
  const githubConnections = dependencies.githubConnections
  const idempotency = dependencies.idempotency
  const audit = dependencies.audit

  app.use('*', async (c, next) => {
    const startedAt = Date.now()
    c.set('requestId', crypto.randomUUID())
    try {
      await next()
    } finally {
      c.header('Request-Id', c.get('requestId'))
      const failure = c.get('failure')
      const record = JSON.stringify({
        event: 'request.complete',
        requestId: c.get('requestId'),
        method: c.req.method,
        path: new URL(c.req.url).pathname,
        status: c.res.status,
        durationMs: Date.now() - startedAt,
        ...(failure ? { failure } : {}),
      })
      if (c.res.status >= 500) console.error(record)
      else console.info(record)
    }
  })

  app.get('/health', (c) => c.json({ status: 'ok' }))
  app.get('/providers/github/manifest', (c) => c.json(githubManifest))

  app.get('/.well-known/oauth-protected-resource/github', (c) => {
    const resource = githubResource(config.origin)
    return c.json({
      resource,
      authorization_servers: [config.realmrootIssuer],
      scopes_supported: githubScopes,
      bearer_methods_supported: ['header'],
      account_connection_modes_supported: ['brokered'],
      account_connection_authorization_endpoint: `${resource}/account-connection-authorizations`,
      account_connection_token_endpoint: `${resource}/account-connection-credentials`,
      account_connection_revocation_endpoint: `${resource}/account-connection-revocations`,
    })
  })

  app.get('/github/openapi.json', (c) => {
    return c.json(
      githubOpenApi({
        resource: githubResource(config.origin),
        realmrootIssuer: config.realmrootIssuer,
      }),
      200,
      {
        'Content-Type': 'application/vnd.oai.openapi+json',
      },
    )
  })

  app.get('/github', (c) => {
    const resource = githubResource(config.origin)
    return c.json({ resource, serviceDescription: `${resource}/openapi.json`, identityLevel: 'brokered' }, 200, {
      Link: `<${resource}/openapi.json>; rel="service-desc"; type="application/vnd.oai.openapi+json"`,
    })
  })

  app.get('/github/account-connection-authorizations', async (c) => {
    const request = c.req.query('request')
    if (!request || !dependencies.connectionRequestVerifier || !githubConnections || !githubConnection) {
      throw new HttpProblem(
        503,
        'urn:realmroot:adapter:not-configured',
        'Service Unavailable',
        'GitHub account connection is not configured.',
      )
    }
    const connectionRequest = await dependencies.connectionRequestVerifier(request)
    const providerState = randomToken()
    await githubConnections.create(connectionRequest, providerState)
    return c.redirect(githubConnection.authorizationUrl(providerState))
  })

  app.get('/github/oauth/callback', async (c) => {
    if (!githubConnections || !githubConnection) throw notConfiguredConnection()
    const state = requiredQuery(c.req.query('state'), 'GitHub OAuth state')
    const code = requiredQuery(c.req.query('code'), 'GitHub OAuth code')
    const intent = await githubConnections.findByProviderState(state, 'pending_oauth')
    const userToken = await githubConnection.exchangeUserCode(code)
    const [user, installations] = await Promise.all([
      githubConnection.getUser(userToken),
      githubConnection.listUserInstallations(userToken),
    ])
    if (intent.expectedInstallationId && !installations.some((item) => item.id === intent.expectedInstallationId)) {
      throw forbidden('The authorized GitHub user cannot manage the selected App installation.')
    }
    if (installations.length === 0) {
      const installState = randomToken()
      await githubConnections.rotateProviderState(intent.requestId, installState, 'awaiting_install', null)
      return c.redirect(await githubConnection.newInstallationUrl(installState))
    }
    return completeGitHubAuthorization(c, githubConnections, intent, user, installations)
  })

  app.get('/github/account-connection-installations', async (c) => {
    if (!githubConnections || !githubConnection) throw notConfiguredConnection()
    const state = requiredQuery(c.req.query('state'), 'GitHub installation state')
    const installation = installationId(requiredQuery(c.req.query('installation_id'), 'GitHub installation ID'))
    const intent = await githubConnections.findByProviderState(state, 'awaiting_install')
    const oauthState = randomToken()
    await githubConnections.rotateProviderState(intent.requestId, oauthState, 'pending_oauth', installation)
    return c.redirect(githubConnection.authorizationUrl(oauthState))
  })

  app.post('/github/account-connection-credentials', async (c) => {
    if (!githubConnections) throw notConfiguredConnection()
    const form = await c.req.formData()
    const code = requiredForm(form, 'code')
    const verifier = requiredForm(form, 'code_verifier')
    const connectionRequestId = requiredForm(form, 'connection_id')
    const { binding, brokerReference, contexts } = await githubConnections.exchange(code, verifier, connectionRequestId)
    return c.json({
      external_subject: String(binding.githubUserId),
      display_name: binding.displayName,
      broker_reference: brokerReference,
      scope: (JSON.parse(binding.scopesJson) as string[]).join(' '),
      authorization_details: contexts.map((context) => ({
        type: 'github_installation',
        installation_id: String(context.installationId),
        account_login: context.accountLogin,
        target_type: context.targetType,
      })),
    })
  })

  app.post('/github/account-connection-revocations', async (c) => {
    if (!dependencies.revocationRequestVerifier || !githubConnections) throw notConfiguredConnection()
    const form = await c.req.formData()
    const signedRequest = requiredForm(form, 'request')
    const revocation = await dependencies.revocationRequestVerifier(signedRequest)
    await githubConnections.revoke({
      brokerReference: revocation.broker_reference,
      ownerSubject: revocation.sub,
      jti: revocation.jti,
      expiresAt: revocation.exp * 1000,
    })
    return c.body(null, 204)
  })

  app.get('/github/repositories', async (c) => {
    requireApiVersion(c.req.header('API-Version'))
    const principal = await authenticator.authenticate(c.req.raw, githubResource(config.origin))
    requireScope(principal.scopes, 'github:metadata:read')
    const installationIds = await connectionInstallationIds(principal)
    const query = paginationSchema.parse(c.req.query())
    const repositories = (await Promise.all(installationIds.map((id) => allRepositories(id)))).flat()
    const offset = (query.page - 1) * query.perPage
    const items = repositories.slice(offset, offset + query.perPage)
    const hasMore = offset + query.perPage < repositories.length
    if (hasMore) {
      const next = new URL(c.req.url)
      next.searchParams.set('page', String(query.page + 1))
      next.searchParams.set('perPage', String(query.perPage))
      c.header('Link', `<${next}>; rel="next"`)
    }
    c.header('API-Version', adapterApiVersion)
    c.header('Vary', 'API-Version')
    return c.json({
      items,
      pagination: { page: query.page, perPage: query.perPage, total: repositories.length, hasMore },
    })
  })

  app.post('/github/repos/:owner/:repository/issues', async (c) => {
    requireApiVersion(c.req.header('API-Version'))
    const principal = await authenticator.authenticate(c.req.raw, githubResource(config.origin))
    requireScope(principal.scopes, 'github:issues:write')
    const installationIds = await connectionInstallationIds(principal)
    const input = issueInputSchema.parse(await readJson(c.req.raw))
    const owner = c.req.param('owner')
    const repository = c.req.param('repository')
    const result = await idempotency.execute(
      c.req.header('Idempotency-Key') ?? null,
      `${principal.actor.issuer}:${principal.actor.subject}:${principal.connectionId}:${owner.toLowerCase()}/${repository.toLowerCase()}:create-issue`,
      input,
      async () => {
        const display = await agentInfo.resolve(principal)
        const body = attributedBody(input.body, principal, display, c.get('requestId'))
        const id = await repositoryInstallation(installationIds, owner, repository)
        const issue = await github.createIssue({
          installationId: id,
          owner,
          repository,
          title: input.title,
          body,
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

  async function connectionInstallationIds(principal: Awaited<ReturnType<RealmrootAuthenticator['authenticate']>>) {
    if (!principal.connectionId || !githubConnections) {
      throw forbidden('A brokered GitHub account connection is required.')
    }
    const ids = await githubConnections.activeInstallationIdsForOwner(principal.subject)
    const selected = (principal.authorizationDetails ?? []).flatMap((detail) =>
      detail.type === 'github_installation' && typeof detail.installation_id === 'string'
        ? [installationId(detail.installation_id)]
        : [],
    )
    if (selected.length === 0) return ids
    if (selected.some((id) => !ids.includes(id))) throw forbidden('Token contains an unconnected GitHub installation.')
    return [...new Set(selected)]
  }

  async function allRepositories(installationId: number) {
    const items = []
    for (let page = 1; ; page += 1) {
      const result = await github.listRepositories(installationId, page, 100)
      items.push(...result.items.map((repository) => ({ ...repository, installationId })))
      if (page * 100 >= result.total) return items
    }
  }

  async function repositoryInstallation(installationIds: number[], owner: string, repository: string) {
    for (const id of installationIds) {
      const repositories = await allRepositories(id)
      if (
        repositories.some(
          (candidate) =>
            candidate.owner.toLowerCase() === owner.toLowerCase() &&
            candidate.name.toLowerCase() === repository.toLowerCase(),
        )
      )
        return id
    }
    throw forbidden('The repository is outside the connected GitHub installations.')
  }

  async function completeGitHubAuthorization(
    c: Context,
    connectionStore: GitHubConnectionStore,
    intent: GitHubConnectionIntent,
    user: Awaited<ReturnType<GitHubConnectionProvider['getUser']>>,
    installations: Awaited<ReturnType<GitHubConnectionProvider['listUserInstallations']>>,
  ) {
    const code = randomToken()
    await connectionStore.complete(intent, user, installations, code)
    const callback = new URL(intent.callbackUri)
    callback.searchParams.set('state', intent.realmrootState)
    callback.searchParams.set('code', code)
    return c.redirect(callback.toString())
  }

  app.notFound((c) =>
    problemResponse(
      new HttpProblem(404, 'about:blank', 'Not Found', 'The resource was not found.'),
      c.req.url,
      c.get('requestId'),
    ),
  )
  app.onError((error, c) => {
    const problem = normalizeProblem(error)
    c.set('failure', {
      type: problem.type,
      ...(problem.status >= 500 ? { error: serializedError(error) } : {}),
    })
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

function configuredGitHubConnection(config: AppConfig): GitHubConnectionProvider | undefined {
  if (!config.githubAppId || !config.githubPrivateKey || !config.githubClientId || !config.githubClientSecret) return
  return createGitHubConnectionProvider({
    appId: config.githubAppId,
    privateKey: config.githubPrivateKey,
    clientId: config.githubClientId,
    clientSecret: config.githubClientSecret,
    redirectUri: `${githubResource(config.origin)}/oauth/callback`,
    apiOrigin: config.githubApiOrigin,
  })
}

function githubResource(origin: string) {
  return `${origin}/github`
}

function installationId(value: string) {
  const parsed = Number(value)
  if (!Number.isSafeInteger(parsed) || parsed <= 0) throw badRequest('The GitHub installation ID is invalid.')
  return parsed
}

function randomToken() {
  const bytes = crypto.getRandomValues(new Uint8Array(32))
  return btoa(String.fromCharCode(...bytes))
    .replaceAll('+', '-')
    .replaceAll('/', '_')
    .replace(/=+$/, '')
}

function requiredQuery(value: string | undefined, label: string) {
  if (!value) throw badRequest(`${label} is required.`)
  return value
}

function requiredForm(form: FormData, name: string) {
  const value = form.get(name)
  if (typeof value !== 'string' || !value) throw badRequest(`${name} is required.`)
  return value
}

function notConfiguredConnection() {
  return new HttpProblem(
    503,
    'urn:realmroot:adapter:not-configured',
    'Service Unavailable',
    'GitHub account connection is not configured.',
  )
}

function requireApiVersion(value: string | undefined) {
  if (value !== undefined && value !== adapterApiVersion)
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
  return new HttpProblem(500, 'about:blank', 'Internal Server Error', 'The adapter could not complete the request.')
}

function serializedError(error: unknown) {
  if (error instanceof Error) {
    return { name: error.name, message: error.message, ...(error.stack ? { stack: error.stack } : {}) }
  }
  return { name: 'UnknownError', message: String(error) }
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
