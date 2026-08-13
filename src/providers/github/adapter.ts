import type { Context, Hono } from 'hono'
import type { AdapterEnv, AdapterModule } from '../../core/adapter.js'
import { type AgentInfoResolver, createAgentInfoResolver } from '../../core/agent-info.js'
import type { ConnectionEventSink } from '../../core/connection-events.js'
import type { BrokeredConnectionRequest, BrokeredRevocationRequest } from '../../core/connection-request.js'
import { badRequest, forbidden, HttpProblem, insufficientScope } from '../../core/problem.js'
import type { AgentPrincipal, RealmrootAuthenticator } from '../../core/realmroot-auth.js'
import { createGitHubConnectionProvider, createGitHubProvider } from './client.js'
import type { GitHubAdapterConfig } from './config.js'
import type { GitHubAuthorizationContext, GitHubConnectionIntent, GitHubConnectionStore } from './connections.js'
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
import type { GitHubConnectionProvider, GitHubInstallation, GitHubProvider } from './types.js'
import { handleGitHubWebhook } from './webhooks.js'

export type GitHubAdapterDependencies = {
  authenticator: RealmrootAuthenticator
  audit: (record: Record<string, unknown>) => Promise<void>
  agentInfo?: AgentInfoResolver
  provider?: GitHubProvider
  connection?: GitHubConnectionProvider
  connections?: GitHubConnectionStore
  connectionRequestVerifier?: (request: string) => Promise<BrokeredConnectionRequest>
  revocationRequestVerifier?: (request: string) => Promise<BrokeredRevocationRequest>
  connectionEvents?: ConnectionEventSink
  connectionEventBarrier?: () => Promise<void>
}

export function createGitHubAdapter(
  config: GitHubAdapterConfig,
  dependencies: GitHubAdapterDependencies,
): AdapterModule {
  const resource = `${config.origin}/github`
  const provider = dependencies.provider ?? configuredProvider(config)
  const connection = dependencies.connection ?? configuredConnection(config)
  const agentInfo = dependencies.agentInfo ?? createAgentInfoResolver(fetch, config.realmrootAgentProfileUriTemplate)

  return {
    id: 'github',
    register(app) {
      registerGitHubRoutes(app)
    },
  }

  function registerGitHubRoutes(app: Hono<AdapterEnv>) {
    app.use('/github/*', async (c, next) => {
      if (c.req.path !== '/github' && c.req.path !== '/github/openapi.json') {
        await dependencies.connectionEventBarrier?.()
      }
      await next()
    })

    app.get('/providers/github/manifest', async (c) => c.json(githubManifest(await provider.appPermissions())))

    app.get('/.well-known/oauth-protected-resource/github', async (c) =>
      c.json({
        resource,
        authorization_servers: [config.realmrootIssuer],
        scopes_supported: permissionsToScopes(await provider.appPermissions()),
        bearer_methods_supported: ['header'],
        account_connection_modes_supported: ['brokered'],
        account_connection_authorization_endpoint: `${resource}/account-connection-authorizations`,
        account_connection_token_endpoint: `${resource}/account-connection-credentials`,
        account_connection_revocation_endpoint: `${resource}/account-connection-revocations`,
        account_connection_authorization_details_endpoint: `${resource}/account-connection-authorization-details`,
      }),
    )

    app.get('/github/openapi.json', async (c) => {
      const [response, permissions] = await Promise.all([provider.openApiDocument(), provider.appPermissions()])
      return c.json(
        await githubOpenApi({ resource, realmrootIssuer: config.realmrootIssuer, permissions, response }),
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
          providerConnectionMode: 'brokered',
          providerActorMode: 'github-app-installation',
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

    app.get('/github/account-connection-authorizations', async (c) => {
      const request = c.req.query('request')
      if (!request || !dependencies.connectionRequestVerifier || !dependencies.connections || !connection) {
        throw notConfiguredConnection()
      }
      const connectionRequest = await dependencies.connectionRequestVerifier(request)
      const providerState = randomToken()
      await dependencies.connections.create(connectionRequest, providerState)
      return c.redirect(connection.authorizationUrl(providerState))
    })

    app.get('/github/oauth/callback', async (c) => {
      if (!dependencies.connections || !connection) throw notConfiguredConnection()
      const state = required(c.req.query('state'), 'GitHub OAuth state')
      const code = required(c.req.query('code'), 'GitHub OAuth code')
      const intent = await dependencies.connections.findByProviderState(state, 'pending_oauth')
      const userToken = await connection.exchangeUserCode(code)
      const [user, installations] = await Promise.all([
        connection.getUser(userToken),
        connection.listUserInstallations(userToken),
      ])
      if (intent.expectedInstallationId && !installations.some((item) => item.id === intent.expectedInstallationId)) {
        throw forbidden('The authorized GitHub user cannot manage the selected App installation.')
      }
      if (installations.length === 0) {
        const installState = randomToken()
        await dependencies.connections.rotateProviderState(intent.requestId, installState, 'awaiting_install', null)
        return c.redirect(await connection.newInstallationUrl(installState))
      }
      return completeAuthorization(c, dependencies.connections, intent, user, installations)
    })

    app.get('/github/account-connection-installations', async (c) => {
      if (!dependencies.connections || !connection) throw notConfiguredConnection()
      const state = required(c.req.query('state'), 'GitHub installation state')
      const installation = installationId(required(c.req.query('installation_id'), 'GitHub installation ID'))
      const intent = await dependencies.connections.findByProviderState(state, 'awaiting_install')
      const oauthState = randomToken()
      await dependencies.connections.rotateProviderState(intent.requestId, oauthState, 'pending_oauth', installation)
      return c.redirect(connection.authorizationUrl(oauthState))
    })

    app.post('/github/account-connection-credentials', async (c) => {
      if (!dependencies.connections) throw notConfiguredConnection()
      const form = await c.req.formData()
      const { binding, brokerReference, contexts } = await dependencies.connections.exchange(
        requiredForm(form, 'code'),
        requiredForm(form, 'code_verifier'),
        requiredForm(form, 'connection_id'),
      )
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
          repository_selection: context.repositorySelection,
          ...(context.repositorySelection === 'selected'
            ? {
                repositories: context.repositories.map((repository) => ({
                  id: String(repository.id),
                  full_name: repository.fullName,
                })),
              }
            : {}),
        })),
      })
    })

    app.post('/github/account-connection-revocations', async (c) => {
      if (!dependencies.revocationRequestVerifier || !dependencies.connections) throw notConfiguredConnection()
      const signedRequest = requiredForm(await c.req.formData(), 'request')
      const revocation = await dependencies.revocationRequestVerifier(signedRequest)
      await dependencies.connections.revoke({
        brokerReference: revocation.broker_reference,
        ownerSubject: revocation.sub,
        jti: revocation.jti,
        expiresAt: revocation.exp * 1000,
      })
      return c.body(null, 204)
    })

    app.get('/github/account-connection-authorization-details', async (c) => {
      if (!dependencies.connections) throw notConfiguredConnection()
      const brokerReference = bearerCredential(c.req.header('authorization'))
      const contexts = await dependencies.connections.activeInstallationsForReference(brokerReference)
      const { limit, offset } = catalogPagination(c.req.query('limit'), c.req.query('offset'))
      const items = contexts.slice(offset, offset + limit).map((context) => ({
        authorizationDetail: contextAuthorizationDetail(context),
        display: {
          label: context.accountLogin,
          description: `${context.targetType} GitHub App installation`,
          metadata: {
            accountType: context.targetType,
            repositories:
              context.repositorySelection === 'all'
                ? 'All repositories'
                : `${context.repositories.length} selected repositories`,
          },
        },
      }))
      const nextOffset = offset + items.length < contexts.length ? offset + items.length : null
      return c.json(
        {
          items,
          pagination: {
            limit,
            offset,
            total: contexts.length,
            hasMore: nextOffset !== null,
            nextOffset,
          },
        },
        200,
        { 'Cache-Control': 'no-store' },
      )
    })

    app.post('/github/webhooks', async (c) => {
      if (!config.githubWebhookSecret || !dependencies.connections || !dependencies.connectionEvents) {
        throw notConfiguredConnection()
      }
      await handleGitHubWebhook({
        request: c.req.raw,
        secret: config.githubWebhookSecret,
        connections: dependencies.connections,
        events: dependencies.connectionEvents,
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
        providerConnectionMode: 'brokered',
        result: { status: response.status },
        occurredAt: new Date().toISOString(),
      })
      return response
    })
  }

  async function selectedInstallation(principal: AgentPrincipal) {
    if (!principal.connectionId || !dependencies.connections) {
      throw forbidden('A brokered GitHub account connection is required.')
    }
    const connected = await dependencies.connections.activeInstallationsForOwner(
      principal.subject,
      principal.connectionId,
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
      providerConnectionMode: 'brokered',
      result: { status },
      occurredAt: new Date().toISOString(),
    })
  }
}

function contextAuthorizationDetail(context: GitHubAuthorizationContext) {
  return {
    type: 'github_installation',
    installation_id: String(context.installationId),
    account_login: context.accountLogin,
    target_type: context.targetType,
    repository_selection: context.repositorySelection,
    ...(context.repositorySelection === 'selected'
      ? {
          repositories: context.repositories.map((repository) => ({
            id: String(repository.id),
            full_name: repository.fullName,
          })),
        }
      : {}),
  }
}

function bearerCredential(value: string | undefined) {
  const match = /^Bearer ([^\s]+)$/.exec(value ?? '')
  if (!match) throw forbidden('An active GitHub account connection reference is required.')
  return match[1] as string
}

function catalogPagination(limitValue: string | undefined, offsetValue: string | undefined) {
  const limit = limitValue === undefined ? 100 : Number(limitValue)
  const offset = offsetValue === undefined ? 0 : Number(offsetValue)
  if (!Number.isInteger(limit) || limit < 1 || limit > 100 || !Number.isInteger(offset) || offset < 0) {
    throw badRequest('Authorization detail catalog pagination is invalid.')
  }
  return { limit, offset }
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

function configuredConnection(config: GitHubAdapterConfig) {
  if (!config.githubAppId || !config.githubPrivateKey || !config.githubClientId || !config.githubClientSecret) return
  return createGitHubConnectionProvider({
    appId: config.githubAppId,
    privateKey: config.githubPrivateKey,
    clientId: config.githubClientId,
    clientSecret: config.githubClientSecret,
    redirectUri: `${config.origin}/github/oauth/callback`,
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

async function completeAuthorization(
  c: Context,
  store: GitHubConnectionStore,
  intent: GitHubConnectionIntent,
  user: Awaited<ReturnType<GitHubConnectionProvider['getUser']>>,
  installations: GitHubInstallation[],
) {
  const code = randomToken()
  await store.complete(intent, user, installations, code)
  const callback = new URL(intent.callbackUri)
  callback.searchParams.set('state', intent.realmrootState)
  callback.searchParams.set('code', code)
  return c.redirect(callback.toString())
}

function installationId(value: string) {
  const parsed = Number(value)
  if (!Number.isSafeInteger(parsed) || parsed <= 0) throw badRequest('The GitHub installation ID is invalid.')
  return parsed
}

function required(value: string | undefined, label: string) {
  if (!value) throw badRequest(`${label} is required.`)
  return value
}

function requiredForm(form: FormData, name: string) {
  const value = form.get(name)
  if (typeof value !== 'string' || !value) throw badRequest(`${name} is required.`)
  return value
}

function randomToken() {
  const bytes = crypto.getRandomValues(new Uint8Array(32))
  return btoa(String.fromCharCode(...bytes))
    .replaceAll('+', '-')
    .replaceAll('/', '_')
    .replace(/=+$/, '')
}

function notConfiguredConnection() {
  return new HttpProblem(
    503,
    'urn:realmroot:adapter:not-configured',
    'Service Unavailable',
    'GitHub account connection is not configured.',
  )
}
