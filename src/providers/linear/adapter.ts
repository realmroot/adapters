import type { AdapterModule } from '../../core/adapter.js'
import { type AgentInfoResolver, createAgentInfoResolver } from '../../core/agent-info.js'
import { forbidden, HttpProblem } from '../../core/problem.js'
import type { AgentPrincipal, RealmrootAuthenticator } from '../../core/realmroot-auth.js'
import type { LinearAdapterConfig } from './config.js'
import type { LinearConnectionStore, LinearWorkspaceCredential } from './connections.js'
import { prepareLinearGraphqlRequest } from './graphql.js'
import { linearManifest } from './manifest.js'
import { linearOpenApi } from './openapi.js'
import type { LinearProvider } from './types.js'
import { verifyLinearWebhook } from './webhooks.js'

export type LinearAdapterDependencies = {
  authenticator: RealmrootAuthenticator
  provider: LinearProvider
  connections: LinearConnectionStore
  audit: (record: Record<string, unknown>) => Promise<void>
  agentInfo?: AgentInfoResolver
}

export function createLinearAdapter(
  config: LinearAdapterConfig,
  dependencies: LinearAdapterDependencies,
): AdapterModule {
  const resource = `${config.origin}/linear`
  const issuer = `${config.origin}/oauth/linear`
  const agentInfo = dependencies.agentInfo ?? createAgentInfoResolver(fetch, config.realmrootAgentProfileUriTemplate)

  return {
    id: 'linear',
    register(app) {
      app.get('/providers/linear/manifest', (c) => c.json(linearManifest))
      app.get('/.well-known/oauth-protected-resource/linear', (c) =>
        c.json({
          resource,
          authorization_servers: [issuer],
          scopes_supported: Object.keys(linearManifest.scopes),
          authorization_details_types_supported: ['linear_workspace'],
          bearer_methods_supported: [],
          dpop_bound_access_tokens_required: true,
        }),
      )
      app.get('/linear/openapi.json', (c) =>
        c.json(linearOpenApi({ resource, realmrootIssuer: issuer }), 200, {
          'Cache-Control': 'public, max-age=300',
          'Content-Type': 'application/vnd.oai.openapi+json',
        }),
      )
      app.get('/linear', (c) =>
        c.json({ resource, serviceDescription: `${resource}/openapi.json`, authorizationModel: 'external' }, 200, {
          Link: `<${resource}/openapi.json>; rel="service-desc"; type="application/vnd.oai.openapi+json"`,
        }),
      )
      app.post('/linear/graphql', async (c) => {
        const principal = await dependencies.authenticator.authenticate(c.req.raw, resource)
        const selectedWorkspaceId = selectedWorkspace(principal)
        let credential = await dependencies.connections.credentialForOwner(principal.subject, selectedWorkspaceId)
        credential = await currentCredential(credential, dependencies.provider, dependencies.connections)
        if (
          ![...principal.scopes].every(
            (scope) => ['openid', 'offline_access'].includes(scope) || credential.scopes.includes(scope),
          )
        ) {
          throw forbidden('The Linear connection does not grant every Agent scope.')
        }
        const body = await prepareLinearGraphqlRequest({ request: c.req.raw, principal, agentInfo })
        const response = await dependencies.provider.request(
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
          authorizationModel: 'external',
          result: { status: response.status },
          occurredAt: new Date().toISOString(),
        })
        return response
      })
      app.post('/linear/webhooks', async (c) => {
        if (!config.linearWebhookSecret || !config.linearClientId) throw notConfiguredWebhook()
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
    },
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
  if (ids.length !== 1) throw forbidden('Select exactly one connected Linear workspace for this request.')
  return ids[0]
}

function notConfiguredWebhook() {
  return new HttpProblem(
    503,
    'urn:realmroot:adapter:not-configured',
    'Service Unavailable',
    'Linear webhook verification is not configured.',
  )
}
