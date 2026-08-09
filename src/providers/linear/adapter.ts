import type { Context, Hono } from 'hono'
import type { AdapterEnv, AdapterModule } from '../../core/adapter.js'
import { type AgentInfoResolver, createAgentInfoResolver } from '../../core/agent-info.js'
import type { BrokeredConnectionRequest, BrokeredRevocationRequest } from '../../core/connection-request.js'
import { badRequest, forbidden, HttpProblem } from '../../core/problem.js'
import type { AgentPrincipal, RealmrootAuthenticator } from '../../core/realmroot-auth.js'
import { createLinearProvider } from './client.js'
import type { LinearAdapterConfig } from './config.js'
import type { LinearConnectionIntent, LinearConnectionStore, LinearWorkspaceCredential } from './connections.js'
import { prepareLinearGraphqlRequest } from './graphql.js'
import { linearManifest } from './manifest.js'
import { linearOpenApi } from './openapi.js'
import { appAuthorizationScopes, parseLinearScopes } from './scopes.js'
import type { LinearProvider } from './types.js'
import { verifyLinearWebhook } from './webhooks.js'

export type LinearAdapterDependencies = {
  authenticator: RealmrootAuthenticator
  audit: (record: Record<string, unknown>) => Promise<void>
  agentInfo?: AgentInfoResolver
  provider?: LinearProvider
  connections?: LinearConnectionStore
  connectionRequestVerifier?: (request: string) => Promise<BrokeredConnectionRequest>
  revocationRequestVerifier?: (request: string) => Promise<BrokeredRevocationRequest>
}

export function createLinearAdapter(
  config: LinearAdapterConfig,
  dependencies: LinearAdapterDependencies,
): AdapterModule {
  const resource = `${config.origin}/linear`
  const provider = dependencies.provider ?? configuredProvider(config)
  const agentInfo = dependencies.agentInfo ?? createAgentInfoResolver(fetch, config.realmrootAgentProfileUriTemplate)

  return {
    id: 'linear',
    register(app) {
      registerLinearRoutes(app)
    },
  }

  function registerLinearRoutes(app: Hono<AdapterEnv>) {
    app.get('/providers/linear/manifest', (c) => c.json(linearManifest))

    app.get('/.well-known/oauth-protected-resource/linear', (c) =>
      c.json({
        resource,
        authorization_servers: [config.realmrootIssuer],
        scopes_supported: Object.keys(linearManifest.scopes),
        bearer_methods_supported: ['header'],
        authorization_details_types_supported: ['linear_workspace'],
        account_connection_modes_supported: ['brokered'],
        account_connection_authorization_endpoint: `${resource}/account-connection-authorizations`,
        account_connection_token_endpoint: `${resource}/account-connection-credentials`,
        account_connection_revocation_endpoint: `${resource}/account-connection-revocations`,
      }),
    )

    app.get('/linear/openapi.json', (c) =>
      c.json(linearOpenApi({ resource, realmrootIssuer: config.realmrootIssuer }), 200, {
        'Cache-Control': 'public, max-age=300',
        'Content-Type': 'application/vnd.oai.openapi+json',
      }),
    )

    app.get('/linear', (c) =>
      c.json({ resource, serviceDescription: `${resource}/openapi.json`, identityLevel: 'brokered' }, 200, {
        Link: `<${resource}/openapi.json>; rel="service-desc"; type="application/vnd.oai.openapi+json"`,
      }),
    )

    app.get('/linear/account-connection-authorizations', async (c) => {
      const request = c.req.query('request')
      if (!request || !dependencies.connectionRequestVerifier || !dependencies.connections) {
        throw notConfiguredConnection()
      }
      const connectionRequest = await dependencies.connectionRequestVerifier(request)
      const providerState = randomToken()
      await dependencies.connections.create(connectionRequest, providerState)
      return c.redirect(provider.authorizationUrl({ actor: 'user', state: providerState, scopes: ['read'] }))
    })

    app.get('/linear/oauth/callback', async (c) => {
      if (!dependencies.connections) throw notConfiguredConnection()
      const state = required(c.req.query('state'), 'Linear OAuth state')
      const code = required(c.req.query('code'), 'Linear OAuth code')
      const intent = await dependencies.connections.findByProviderState(state)
      const token = await provider.exchangeCode(code)
      const viewer = await provider.viewer(token.accessToken)
      if (intent.status === 'pending_user') {
        await provider.revoke(token.refreshToken)
        const appState = randomToken()
        await dependencies.connections.recordUser(intent, viewer, appState)
        return c.redirect(
          provider.authorizationUrl({
            actor: 'app',
            state: appState,
            scopes: appAuthorizationScopes(JSON.parse(intent.scopesJson) as string[]),
          }),
        )
      }
      const requestedScopes = appAuthorizationScopes(JSON.parse(intent.scopesJson) as string[])
      if (!requestedScopes.every((scope) => token.scopes.includes(scope))) {
        throw forbidden('Linear did not grant every requested Provider scope.')
      }
      return completeAuthorization(c, dependencies.connections, intent, viewer, token)
    })

    app.post('/linear/account-connection-credentials', async (c) => {
      if (!dependencies.connections) throw notConfiguredConnection()
      const form = await c.req.formData()
      const { binding, brokerReference, contexts } = await dependencies.connections.exchange(
        requiredForm(form, 'code'),
        requiredForm(form, 'code_verifier'),
        requiredForm(form, 'connection_id'),
      )
      return c.json({
        external_subject: binding.linearUserId,
        display_name: binding.displayName,
        broker_reference: brokerReference,
        scope: parseLinearScopes(JSON.parse(binding.scopesJson) as string[]).join(' '),
        authorization_details: contexts.map((context) => ({
          type: 'linear_workspace',
          workspace_id: context.workspaceId,
          workspace_name: context.workspaceName,
          workspace_url_key: context.workspaceUrlKey,
          app_user_id: context.appUserId,
        })),
      })
    })

    app.post('/linear/account-connection-revocations', async (c) => {
      if (!dependencies.revocationRequestVerifier || !dependencies.connections) throw notConfiguredConnection()
      const signedRequest = requiredForm(await c.req.formData(), 'request')
      const revocation = await dependencies.revocationRequestVerifier(signedRequest)
      const credentials = await dependencies.connections.credentialsForRevocation(
        revocation.broker_reference,
        revocation.sub,
      )
      for (const credential of credentials) await provider.revoke(credential.refreshToken)
      await dependencies.connections.revoke({
        brokerReference: revocation.broker_reference,
        ownerSubject: revocation.sub,
        jti: revocation.jti,
        expiresAt: revocation.exp * 1000,
      })
      return c.body(null, 204)
    })

    app.post('/linear/webhooks', async (c) => {
      if (!dependencies.connections || !config.linearWebhookSecret || !config.linearClientId) {
        throw notConfiguredWebhook()
      }
      const { deliveryId, webhook } = await verifyLinearWebhook({
        request: c.req.raw,
        secret: config.linearWebhookSecret,
        clientId: config.linearClientId,
      })
      if (webhook.type === 'OAuthApp') {
        await dependencies.connections.applyLifecycleWebhook(deliveryId, Date.now() + 24 * 60 * 60 * 1000, {
          type: 'revoked',
          workspaceId: webhook.organizationId,
        })
      } else {
        await dependencies.connections.applyLifecycleWebhook(deliveryId, Date.now() + 24 * 60 * 60 * 1000, {
          type: 'team-access-changed',
          workspaceId: webhook.organizationId,
          appUserId: webhook.appUserId,
          canAccessAllPublicTeams: webhook.canAccessAllPublicTeams,
          addedTeamIds: webhook.addedTeamIds,
          removedTeamIds: webhook.removedTeamIds,
        })
      }
      await dependencies.audit({
        event: 'provider.lifecycle',
        requestId: c.get('requestId'),
        provider: 'linear',
        deliveryId,
        workspaceId: webhook.organizationId,
        action: webhook.action,
        occurredAt: new Date().toISOString(),
      })
      return c.body(null, 204)
    })

    app.post('/linear/graphql', async (c) => {
      if (!dependencies.connections) throw notConfiguredConnection()
      const principal = await dependencies.authenticator.authenticate(c.req.raw, resource)
      const selectedWorkspaceId = selectedWorkspace(principal)
      let credential = await dependencies.connections.credentialForOwner(principal.subject, selectedWorkspaceId)
      credential = await currentCredential(credential, provider, dependencies.connections)
      if (![...principal.scopes].every((scope) => credential.scopes.includes(scope))) {
        throw forbidden('The Linear connection does not grant every Agent scope.')
      }
      const body = await prepareLinearGraphqlRequest({ request: c.req.raw, principal, agentInfo })
      const response = await provider.request(
        new Request(new URL('/graphql', config.linearApiOrigin), {
          method: 'POST',
          headers: c.req.raw.headers,
          body,
          redirect: 'manual',
        }),
        credential.accessToken,
      )
      await dependencies.audit({
        event: 'provider.operation',
        requestId: c.get('requestId'),
        provider: 'linear',
        method: 'POST',
        path: '/graphql',
        workspaceId: credential.workspaceId,
        originatingPrincipal: { issuer: principal.actor.issuer, subject: principal.actor.subject },
        providerActor: { type: 'linear_app_user', id: credential.appUserId },
        identityLevel: 'brokered',
        result: { status: response.status },
        occurredAt: new Date().toISOString(),
      })
      return response
    })
  }
}

function configuredProvider(config: LinearAdapterConfig): LinearProvider {
  if (!config.linearClientId || !config.linearClientSecret) return unavailableProvider()
  return createLinearProvider({
    clientId: config.linearClientId,
    clientSecret: config.linearClientSecret,
    redirectUri: `${config.origin}/linear/oauth/callback`,
    apiOrigin: config.linearApiOrigin,
    authorizationOrigin: config.linearAuthorizationOrigin,
  })
}

function unavailableProvider(): LinearProvider {
  const unavailable = async (): Promise<never> => {
    throw notConfiguredConnection()
  }
  return {
    authorizationUrl() {
      throw notConfiguredConnection()
    },
    exchangeCode: unavailable,
    refresh: unavailable,
    revoke: unavailable,
    viewer: unavailable,
    request: unavailable,
  }
}

async function currentCredential(
  credential: LinearWorkspaceCredential,
  provider: LinearProvider,
  connections: LinearConnectionStore,
) {
  if (credential.tokenExpiresAt > Date.now() + 30_000) return credential
  if (!(await connections.claimRefresh(credential))) {
    throw new HttpProblem(
      503,
      'urn:realmroot:adapter:credential-refresh-in-progress',
      'Service Unavailable',
      'Linear credential refresh is already in progress.',
      { 'Retry-After': '2' },
    )
  }
  try {
    const token = await provider.refresh(credential.refreshToken)
    if (!(await connections.replaceCredential(credential, token))) {
      throw new Error('Linear credential version changed during refresh.')
    }
    return {
      ...credential,
      accessToken: token.accessToken,
      refreshToken: token.refreshToken,
      tokenExpiresAt: token.expiresAt,
      scopes: token.scopes,
      credentialVersion: credential.credentialVersion + 1,
    }
  } catch (error) {
    await connections.releaseRefreshClaim(credential)
    throw error
  }
}

function selectedWorkspace(principal: AgentPrincipal) {
  const ids = (principal.authorizationDetails ?? []).flatMap((detail) =>
    detail.type === 'linear_workspace' && typeof detail.workspace_id === 'string' ? [detail.workspace_id] : [],
  )
  if (ids.length > 1) throw forbidden('Select exactly one Linear workspace for this request.')
  return ids[0]
}

async function completeAuthorization(
  c: Context,
  store: LinearConnectionStore,
  intent: LinearConnectionIntent,
  viewer: Awaited<ReturnType<LinearProvider['viewer']>>,
  token: Awaited<ReturnType<LinearProvider['exchangeCode']>>,
) {
  const code = randomToken()
  await store.complete(intent, viewer, token, code)
  const callback = new URL(intent.callbackUri)
  callback.searchParams.set('state', intent.realmrootState)
  callback.searchParams.set('code', code)
  return c.redirect(callback.toString())
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
    'Linear account connection is not configured.',
  )
}

function notConfiguredWebhook() {
  return new HttpProblem(
    503,
    'urn:realmroot:adapter:not-configured',
    'Service Unavailable',
    'Linear webhook verification is not configured.',
  )
}
