import type { Context, Hono } from 'hono'
import type { AdapterEnv, AdapterModule } from '../../core/adapter.js'
import { type AgentInfoResolver, createAgentInfoResolver } from '../../core/agent-info.js'
import { badRequest, forbidden, HttpProblem, insufficientScope } from '../../core/problem.js'
import type { AgentPrincipal, RealmrootAuthenticator } from '../../core/realmroot-auth.js'
import { createGitHubProvider } from './client.js'
import type { GitHubAdapterConfig } from './config.js'
import type { GitHubAuthorizationContext, GitHubConnectionStore } from './connections.js'
import {
  createGitHubCommentWithRest,
  createGitHubPullRequestWithRest,
  mergeGitHubPullRequestWithRest,
  parseGitHubAddComment,
  parseGitHubCreatePullRequest,
  parseGitHubMergePullRequest,
  resolveGitHubCommentTarget,
  resolveGitHubPullRequestTarget,
  resolveGitHubRepositoryName,
} from './graphql.js'
import { githubManifest } from './manifest.js'
import { githubOpenApi } from './openapi.js'
import { resolveGitHubOperationPermissions } from './operation-permissions.js'
import { permissionsToScopes, scopesToPermissions } from './permissions.js'
import { transformGitHubRequest } from './transformers.js'
import type { GitHubProvider } from './types.js'
import { handleGitHubWebhook } from './webhooks.js'

export type GitHubAdapterDependencies = {
  authenticator: RealmrootAuthenticator
  audit: (record: Record<string, unknown>) => Promise<void>
  agentInfo?: AgentInfoResolver
  provider?: GitHubProvider
  connections?: GitHubConnectionStore
}

export function createGitHubAdapter(
  config: GitHubAdapterConfig,
  dependencies: GitHubAdapterDependencies,
): AdapterModule {
  const resource = `${config.origin}/github`
  const provider = dependencies.provider ?? configuredProvider(config)
  const agentInfo = dependencies.agentInfo ?? createAgentInfoResolver(fetch, config.realmrootAgentProfileUriTemplate)

  return {
    id: 'github',
    register(app) {
      registerGitHubRoutes(app)
    },
  }

  function registerGitHubRoutes(app: Hono<AdapterEnv>) {
    app.get('/providers/github/manifest', async (c) => c.json(githubManifest(await provider.appPermissions())))

    app.get('/.well-known/oauth-protected-resource/github', async (c) =>
      c.json({
        resource,
        authorization_servers: [`${config.origin}/oauth/github`],
        scopes_supported: permissionsToScopes(await provider.appPermissions()),
        authorization_details_types_supported: ['github_installation'],
        bearer_methods_supported: [],
        dpop_bound_access_tokens_required: true,
      }),
    )

    app.get('/github/openapi.json', async (c) => {
      const [response, permissions] = await Promise.all([provider.openApiDocument(), provider.appPermissions()])
      return c.json(
        await githubOpenApi({
          resource,
          realmrootIssuer: `${config.origin}/oauth/github`,
          permissions,
          response,
        }),
        200,
        {
          'Cache-Control': 'public, max-age=300',
          'Content-Type': 'application/vnd.oai.openapi+json',
        },
      )
    })

    app.get('/github', (c) =>
      c.json(
        {
          resource,
          serviceDescription: `${resource}/openapi.json`,
          authorizationModel: 'external',
          toolIntegrations: [
            { id: 'git', executables: ['git'], protocol: 'git-smart-http' },
            { id: 'gh', executables: ['gh'], protocol: 'github-http' },
          ],
        },
        200,
        {
          Link: `<${resource}/openapi.json>; rel="service-desc"; type="application/vnd.oai.openapi+json"`,
        },
      ),
    )

    app.post('/github/webhooks', async (c) => {
      if (!config.githubWebhookSecret || !dependencies.connections) {
        throw notConfiguredConnection()
      }
      await handleGitHubWebhook({
        request: c.req.raw,
        secret: config.githubWebhookSecret,
        connections: dependencies.connections,
      })
      return c.body(null, 204)
    })

    app.post('/github/graphql', async (c) => {
      const principal = await dependencies.authenticator.authenticate(c.req.raw, resource)
      const installation = await selectedInstallation(principal)
      const available = scopesToPermissions(new Set(installation.scopes), await provider.appPermissions())
      const permissions = scopesToPermissions(principal.scopes, available)
      const body = await transformGitHubRequest({
        request: c.req.raw,
        upstreamPath: '/graphql',
        principal,
        agentInfo,
        requestId: c.get('requestId'),
      })
      const createPullRequest = parseGitHubCreatePullRequest(body)
      if (createPullRequest) {
        const requiredScopes = new Set(['metadata:read', 'pull_requests:write'])
        const missingScopes = [...requiredScopes].filter((scope) => !principal.scopes.has(scope))
        if (missingScopes.length > 0) {
          throw insufficientScope(`The Agent token does not authorize ${missingScopes.join(', ')}.`, [
            [...requiredScopes],
          ])
        }
        const lookupToken = await provider.installationToken({
          installationId: installation.installationId,
          permissions: scopesToPermissions(new Set(['metadata:read']), available),
          ...(installation.repositorySelection === 'selected'
            ? {
                repositories: installation.repositories.map(
                  (repository) => repository.fullName.split('/').at(-1) as string,
                ),
              }
            : {}),
        })
        const nameWithOwner = await resolveGitHubRepositoryName({
          provider,
          token: lookupToken,
          apiOrigin: config.githubApiOrigin,
          repositoryId: createPullRequest.repositoryId,
        })
        const repository = repositoryTarget(`/repos/${nameWithOwner}`, installation)
        const createToken = await provider.installationToken({
          installationId: installation.installationId,
          permissions: scopesToPermissions(new Set(['pull_requests:write']), available),
          repositories: [repository as string],
        })
        const response = await createGitHubPullRequestWithRest({
          provider,
          token: createToken,
          apiOrigin: config.githubApiOrigin,
          nameWithOwner,
          pullRequest: createPullRequest,
        })
        await auditNative(c, principal, installation, 'graphql-create-pull-request-rest-compatibility', response.status)
        return response
      }
      const addComment = parseGitHubAddComment(body)
      if (addComment) {
        const commentScope = principal.scopes.has('issues:write')
          ? 'issues:write'
          : principal.scopes.has('pull_requests:write')
            ? 'pull_requests:write'
            : null
        if (!principal.scopes.has('metadata:read') || !commentScope) {
          throw insufficientScope('The Agent token does not authorize a GitHub comment.', [
            ['metadata:read', 'issues:write'],
            ['metadata:read', 'pull_requests:write'],
          ])
        }
        const lookupToken = await provider.installationToken({
          installationId: installation.installationId,
          permissions: scopesToPermissions(new Set(['metadata:read']), available),
          ...(installation.repositorySelection === 'selected'
            ? {
                repositories: installation.repositories.map(
                  (repository) => repository.fullName.split('/').at(-1) as string,
                ),
              }
            : {}),
        })
        const target = await resolveGitHubCommentTarget({
          provider,
          token: lookupToken,
          apiOrigin: config.githubApiOrigin,
          subjectId: addComment.subjectId,
        })
        const repository = repositoryTarget(`/repos/${target.nameWithOwner}`, installation)
        const commentToken = await provider.installationToken({
          installationId: installation.installationId,
          permissions: scopesToPermissions(new Set([commentScope]), available),
          repositories: [repository as string],
        })
        const response = await createGitHubCommentWithRest({
          provider,
          token: commentToken,
          apiOrigin: config.githubApiOrigin,
          nameWithOwner: target.nameWithOwner,
          number: target.number,
          comment: addComment,
        })
        await auditNative(c, principal, installation, 'graphql-add-comment-rest-compatibility', response.status)
        return response
      }
      const mergePullRequest = parseGitHubMergePullRequest(body)
      if (mergePullRequest) {
        const requiredScopes = new Set(['contents:write', 'metadata:read'])
        const missingScopes = [...requiredScopes].filter((scope) => !principal.scopes.has(scope))
        if (missingScopes.length > 0) {
          throw insufficientScope(`The Agent token does not authorize ${missingScopes.join(', ')}.`, [
            [...requiredScopes],
          ])
        }
        const lookupToken = await provider.installationToken({
          installationId: installation.installationId,
          permissions: scopesToPermissions(new Set(['metadata:read']), available),
          ...(installation.repositorySelection === 'selected'
            ? {
                repositories: installation.repositories.map(
                  (repository) => repository.fullName.split('/').at(-1) as string,
                ),
              }
            : {}),
        })
        const target = await resolveGitHubPullRequestTarget({
          provider,
          token: lookupToken,
          apiOrigin: config.githubApiOrigin,
          pullRequestId: mergePullRequest.pullRequestId,
        })
        const repository = repositoryTarget(`/repos/${target.nameWithOwner}`, installation)
        const mergeToken = await provider.installationToken({
          installationId: installation.installationId,
          permissions: scopesToPermissions(new Set(['contents:write']), available),
          repositories: [repository as string],
        })
        const response = await mergeGitHubPullRequestWithRest({
          provider,
          token: mergeToken,
          apiOrigin: config.githubApiOrigin,
          nameWithOwner: target.nameWithOwner,
          number: target.number,
          pullRequest: mergePullRequest,
        })
        await auditNative(c, principal, installation, 'graphql-merge-pull-request-rest-compatibility', response.status)
        return response
      }
      const token = await provider.installationToken({
        installationId: installation.installationId,
        permissions,
        ...(installation.repositorySelection === 'selected'
          ? {
              repositories: installation.repositories.map(
                (repository) => repository.fullName.split('/').at(-1) as string,
              ),
            }
          : {}),
      })
      const upstream = new URL('/graphql', config.githubApiOrigin)
      const response = await provider.request(
        new Request(upstream, {
          method: 'POST',
          headers: c.req.raw.headers,
          body,
          duplex: 'half',
        } as RequestInit & { duplex: 'half' }),
        token,
      )
      await auditNative(c, principal, installation, 'graphql', response.status)
      return response
    })

    app.all('/github/git/*', async (c) => {
      const target = gitTransportTarget(c.req.url, c.req.method, config.githubGitOrigin)
      const principal = await dependencies.authenticator.authenticate(c.req.raw, resource)
      const installation = await selectedInstallation(principal)
      const repository = repositoryTarget(`/repos/${target.owner}/${target.repository}`, installation)
      const requestedScopes = new Set<string>([target.write ? 'contents:write' : 'contents:read'])
      if (target.write) requestedScopes.add('workflows:write')
      const missingScopes = [...requestedScopes].filter((scope) => !principal.scopes.has(scope))
      if (missingScopes.length > 0) {
        throw insufficientScope(`The Agent token does not authorize ${missingScopes.join(', ')}.`, [
          [...requestedScopes],
        ])
      }
      const available = scopesToPermissions(new Set(installation.scopes), await provider.appPermissions())
      const permissions = scopesToPermissions(requestedScopes, available)
      const token = await provider.installationToken({
        installationId: installation.installationId,
        permissions,
        repositories: [repository as string],
      })
      const response = await provider.request(
        new Request(target.url, {
          method: c.req.method,
          headers: c.req.raw.headers,
          ...(c.req.method === 'GET' || c.req.method === 'HEAD' ? {} : { body: c.req.raw.body, duplex: 'half' }),
          redirect: 'manual',
        } as RequestInit & { duplex?: 'half' }),
        token,
        'git',
      )
      await auditNative(
        c,
        principal,
        installation,
        target.write ? 'git-receive-pack' : 'git-upload-pack',
        response.status,
      )
      return response
    })

    app.all('/github/*', async (c) => {
      const principal = await dependencies.authenticator.authenticate(c.req.raw, resource)
      const installation = await selectedInstallation(principal)
      const available = scopesToPermissions(new Set(installation.scopes), await provider.appPermissions())
      const upstream = upstreamUrl(c.req.url, c.req.method, config)
      const permissions = resolveGitHubOperationPermissions({
        method: c.req.method,
        path: upstream.pathname,
        scopes: principal.scopes,
        available,
      })
      const repository = repositoryTarget(upstream.pathname, installation)
      const body = await transformGitHubRequest({
        request: c.req.raw,
        upstreamPath: upstream.pathname,
        principal,
        agentInfo,
        requestId: c.get('requestId'),
      })
      const token = await provider.installationToken({
        installationId: installation.installationId,
        permissions,
        ...(repository ? { repositories: [repository] } : {}),
      })
      const upstreamRequest = new Request(upstream, {
        method: c.req.method,
        headers: c.req.raw.headers,
        ...(body ? { body } : {}),
        ...(body instanceof ReadableStream ? { duplex: 'half' as const } : {}),
        redirect: 'manual',
      } as RequestInit & { duplex?: 'half' })
      const response = await provider.request(upstreamRequest, token)
      await dependencies.audit({
        event: 'provider.operation',
        requestId: c.get('requestId'),
        provider: 'github',
        method: c.req.method,
        path: upstream.pathname,
        installationId: installation.installationId,
        originatingPrincipal: { issuer: principal.actor.issuer, subject: principal.actor.subject },
        providerActor: { type: 'github_app', id: config.githubAppId ?? 'injected-test-provider' },
        identityLevel: 'provider-delegated',
        result: { status: response.status },
        occurredAt: new Date().toISOString(),
      })
      return response
    })
  }

  async function selectedInstallation(principal: AgentPrincipal) {
    if (!dependencies.connections) throw forbidden('A GitHub account connection is required.')
    const connected = await dependencies.connections.activeInstallationsForOwner(
      principal.subject,
      `github:${principal.subject}`,
    )
    const selectedIds = (principal.authorizationDetails ?? []).flatMap((detail) =>
      detail.type === 'github_installation' && typeof detail.installation_id === 'string'
        ? [installationId(detail.installation_id)]
        : [],
    )
    if (selectedIds.length > 1) throw forbidden('Select exactly one GitHub installation for this request.')
    const selected =
      selectedIds.length === 1 ? connected.find((item) => item.installationId === selectedIds[0]) : connected[0]
    if (!selected || (selectedIds.length === 0 && connected.length !== 1)) {
      throw forbidden('Select exactly one connected GitHub installation for this request.')
    }
    return selected
  }

  async function auditNative(
    c: Context,
    principal: AgentPrincipal,
    installation: GitHubAuthorizationContext,
    operation: string,
    status: number,
  ) {
    await dependencies.audit({
      event: 'provider.operation',
      requestId: c.get('requestId'),
      provider: 'github',
      operation,
      installationId: installation.installationId,
      originatingPrincipal: { issuer: principal.actor.issuer, subject: principal.actor.subject },
      providerActor: { type: 'github_app', id: config.githubAppId ?? 'injected-test-provider' },
      identityLevel: 'provider-delegated',
      result: { status },
      occurredAt: new Date().toISOString(),
    })
  }
}

function gitTransportTarget(requestUrl: string, method: string, origin: string) {
  const request = new URL(requestUrl)
  const match = /^\/github\/git\/([^/]+)\/([^/]+)\.git\/(info\/refs|git-upload-pack|git-receive-pack)$/.exec(
    request.pathname,
  )
  if (!match) throw new HttpProblem(404, 'about:blank', 'Not Found', 'Git transport operation is not published.')
  const owner = decodeURIComponent(match[1] as string)
  const repository = decodeURIComponent(match[2] as string)
  const operation = match[3]
  const service = request.searchParams.get('service')
  const write = operation === 'git-receive-pack' || service === 'git-receive-pack'
  const read = operation === 'git-upload-pack' || service === 'git-upload-pack'
  if (
    (!read && !write) ||
    (operation === 'info/refs' && method !== 'GET') ||
    (operation !== 'info/refs' && method !== 'POST')
  ) {
    throw new HttpProblem(404, 'about:blank', 'Not Found', 'Git transport operation is not published.')
  }
  const url = new URL(`/${encodeURIComponent(owner)}/${encodeURIComponent(repository)}.git/${operation}`, origin)
  url.search = request.search
  return { owner, repository, operation, write, url }
}

function configuredProvider(config: GitHubAdapterConfig): GitHubProvider {
  if (!config.githubAppId || !config.githubPrivateKey) return unavailableProvider()
  return createGitHubProvider({
    appId: config.githubAppId,
    privateKey: config.githubPrivateKey,
    apiOrigin: config.githubApiOrigin,
  })
}

function unavailableProvider(): GitHubProvider {
  const unavailable = async (): Promise<never> => {
    throw new HttpProblem(
      503,
      'urn:realmroot:adapter:not-configured',
      'Service Unavailable',
      'GitHub App credentials are not configured.',
    )
  }
  return {
    appPermissions: unavailable,
    openApiDocument: unavailable,
    installationToken: unavailable,
    request: unavailable,
  }
}

function upstreamUrl(requestUrl: string, method: string, config: GitHubAdapterConfig) {
  const request = new URL(requestUrl)
  const pathname = request.pathname.slice('/github'.length) || '/'
  const upstream = new URL(isReleaseAssetUpload(method, pathname) ? config.githubUploadsOrigin : config.githubApiOrigin)
  upstream.pathname = pathname
  upstream.search = request.search
  return upstream
}

function isReleaseAssetUpload(method: string, path: string) {
  return method === 'POST' && /^\/repos\/[^/]+\/[^/]+\/releases\/[^/]+\/assets$/.test(path)
}

function repositoryTarget(path: string, installation: GitHubAuthorizationContext) {
  const match = /^\/repos\/([^/]+)\/([^/]+)(?:\/|$)/.exec(path)
  if (!match) return
  const owner = decodeURIComponent(match[1] as string)
  if (owner.toLowerCase() !== installation.accountLogin.toLowerCase()) {
    throw forbidden('The repository owner is outside the selected GitHub installation.')
  }
  const repository = decodeURIComponent(match[2] as string)
  if (
    installation.repositorySelection === 'selected' &&
    !installation.repositories.some(
      (selected) => selected.fullName.toLowerCase() === `${owner}/${repository}`.toLowerCase(),
    )
  ) {
    throw forbidden('The repository is outside the selected GitHub installation authority.')
  }
  return repository
}

function installationId(value: string) {
  const parsed = Number(value)
  if (!Number.isSafeInteger(parsed) || parsed <= 0) throw badRequest('The GitHub installation ID is invalid.')
  return parsed
}

function notConfiguredConnection() {
  return new HttpProblem(
    503,
    'urn:realmroot:adapter:not-configured',
    'Service Unavailable',
    'GitHub account connection is not configured.',
  )
}
