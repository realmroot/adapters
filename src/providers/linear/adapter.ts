import type { AdapterModule } from '../../core/adapter.js'
import { type AgentInfoResolver, createAgentInfoResolver } from '../../core/agent-info.js'
import type { RealmrootTokenExchangeClient } from '../../core/oauth-client.js'
import { forbidden } from '../../core/problem.js'
import type { RealmrootAuthenticator } from '../../core/realmroot-auth.js'
import type { LinearAdapterConfig } from './config.js'
import { prepareLinearGraphqlRequest } from './graphql.js'
import { linearManifest } from './manifest.js'
import { linearOpenApi } from './openapi.js'

export type LinearAdapterDependencies = {
  authenticator: RealmrootAuthenticator
  exchange: RealmrootTokenExchangeClient
  audit: (record: Record<string, unknown>) => Promise<void>
  agentInfo?: AgentInfoResolver
  fetch?: typeof fetch
}

export function createLinearAdapter(
  config: LinearAdapterConfig,
  dependencies: LinearAdapterDependencies,
): AdapterModule {
  const resource = `${config.origin}/linear`
  const request = dependencies.fetch ?? fetch
  const agentInfo = dependencies.agentInfo ?? createAgentInfoResolver(request, config.realmrootAgentProfileUriTemplate)

  return {
    id: 'linear',
    register(app) {
      app.get('/providers/linear/manifest', (c) => c.json(linearManifest))
      app.get('/.well-known/oauth-protected-resource/linear', (c) =>
        c.json({
          resource,
          authorization_servers: [config.realmrootIssuer],
          scopes_supported: Object.keys(linearManifest.scopes),
          authorization_details_types_supported: ['linear_workspace'],
          bearer_methods_supported: ['header'],
        }),
      )
      app.get('/linear/openapi.json', (c) =>
        c.json(linearOpenApi({ resource, realmrootIssuer: config.realmrootIssuer }), 200, {
          'Cache-Control': 'public, max-age=300',
          'Content-Type': 'application/vnd.oai.openapi+json',
        }),
      )
      app.get('/linear', (c) =>
        c.json(
          {
            resource,
            serviceDescription: `${resource}/openapi.json`,
            providerConnectionMode: 'managed',
            providerActorMode: 'linear-app',
          },
          200,
          {
            Link: `<${resource}/openapi.json>; rel="service-desc"; type="application/vnd.oai.openapi+json"`,
          },
        ),
      )
      app.post('/linear/graphql', async (c) => {
        const principal = await dependencies.authenticator.authenticate(c.req.raw, resource)
        if (!principal.subjectToken) throw forbidden('The Realmroot Agent subject token is unavailable.')
        const scopes = [...principal.scopes].filter((scope) => scope in linearManifest.scopes).sort()
        if (scopes.length === 0) throw forbidden('The Agent token has no approved Linear scope.')
        const provider = await dependencies.exchange.exchange({
          subjectToken: principal.subjectToken,
          audience: resource,
          scopes,
        })
        if (!scopes.every((scope) => provider.scopes.has(scope))) {
          throw forbidden('The Linear Provider Connection does not grant every Agent scope.')
        }
        const body = await prepareLinearGraphqlRequest({ request: c.req.raw, principal, agentInfo })
        const response = await request(new URL('/graphql', config.linearApiOrigin), {
          method: 'POST',
          headers: { authorization: `Bearer ${provider.accessToken}`, 'content-type': 'application/json' },
          body,
          redirect: 'manual',
          signal: AbortSignal.timeout(15_000),
        })
        await dependencies.audit({
          event: 'provider.operation',
          requestId: c.get('requestId'),
          provider: 'linear',
          method: 'POST',
          path: '/graphql',
          originatingPrincipal: { issuer: principal.actor.issuer, subject: principal.actor.subject },
          providerActor: { type: 'linear_app' },
          providerConnectionMode: 'managed',
          result: { status: response.status },
          occurredAt: new Date().toISOString(),
        })
        return response
      })
    },
  }
}
