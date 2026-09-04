import type { AdapterModule } from '../../core/adapter.js'
import { createManagedOAuthCredentialSource } from '../../core/managed-oauth.js'
import { createManagedOpenApiAdapter } from '../../core/managed-openapi-adapter.js'
import type { RealmrootAuthenticator } from '../../core/realmroot-auth.js'
import type { Context7AdapterConfig } from './config.js'
import { type Context7OAuthClient, context7AgentScope, type D1Context7Credentials } from './oauth.js'
import { context7OpenApi } from './openapi.js'

export function createContext7Adapter(
  config: Context7AdapterConfig,
  dependencies: {
    authenticator: RealmrootAuthenticator
    provider: Context7OAuthClient
    credentials: D1Context7Credentials
    audit(record: Record<string, unknown>): Promise<void>
    fetch?: typeof fetch
  },
): AdapterModule {
  const resource = `${config.origin}/context7`
  const issuer = `${config.origin}/oauth/context7`
  const operations = [
    {
      operationId: 'listContext7Libraries',
      method: 'GET',
      path: '/libraries',
      upstreamPath: '/v2/libs/search',
      scopes: [context7AgentScope],
    },
    {
      operationId: 'getContext7Documentation',
      method: 'GET',
      path: '/documentation',
      upstreamPath: '/v2/context',
      scopes: [context7AgentScope],
    },
  ] as const
  const credential = createManagedOAuthCredentialSource({
    agentScopes: [context7AgentScope],
    provider: dependencies.provider,
    credentials: dependencies.credentials,
  })

  return createManagedOpenApiAdapter(
    {
      id: 'context7',
      resource,
      issuer,
      upstreamOrigin: config.context7ApiOrigin,
      scopes: { [context7AgentScope]: 'Resolve libraries and read current software documentation.' },
      operations,
      openapi: context7OpenApi({ resource, issuer }),
      representation: { upstream: 'context7', operationMode: 'configured-openapi' },
      manifest: {
        schemaVersion: '0.1',
        provider: 'context7',
        status: 'experimental',
        identity: {
          level: 'provider-delegated',
          visibleInProduct: false,
          visibleInAuditLog: false,
          attribution: 'audit-only',
        },
        actorModes: ['oauth-delegated-user'],
        credentialModes: ['adapter-dynamic-public-oauth'],
        resourceTypes: ['library', 'documentation'],
        scopes: { [context7AgentScope]: { providerPermissions: { oauthScope: 'openid offline_access' } } },
        operations,
        revocationSignals: ['adapter-oauth-revocation', 'context7-oauth-revocation'],
        nativeReadinessGaps: ['ACTOR-NATIVE', 'AGENT-DISPLAY', 'DPOP'],
        retirementCondition: 'Context7 accepts Realmroot Agent identity and proof-bound delegated authority directly.',
      },
    },
    {
      authenticator: dependencies.authenticator,
      audit: dependencies.audit,
      ...(dependencies.fetch ? { fetch: dependencies.fetch } : {}),
      credential,
    },
  )
}
