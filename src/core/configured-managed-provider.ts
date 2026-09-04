import type { JWK } from 'jose'
import type { AdapterModule } from './adapter.js'
import { createCredentialCipher } from './credential-cipher.js'
import {
  createDynamicOAuthClient,
  D1DynamicOAuthRegistrationStore,
  type DynamicOAuthAuthorizationWrapper,
  type DynamicOAuthEndpoints,
} from './dynamic-oauth-client.js'
import { createExternalAuthorizationServer } from './external-authorization-server.js'
import type { D1ExternalOAuthStore } from './external-oauth-store.js'
import {
  createManagedOAuthCredentialSource,
  createManagedOAuthExternalAuthorization,
  D1ManagedOAuthCredentials,
} from './managed-oauth.js'
import { createManagedOpenApiAdapter, type ManagedOpenApiOperation } from './managed-openapi-adapter.js'
import type { DpopReplayStore } from './realmroot-auth.js'

export type ConfiguredManagedProvider = Readonly<{
  id: string
  name: string
  clientName: string
  upstreamOrigin: string
  endpoints: DynamicOAuthEndpoints
  providerScopes: readonly string[]
  agentScopes: Readonly<Record<string, string>>
  operations: readonly ManagedOpenApiOperation[]
  authorizationScopeSeparator?: ' ' | ','
  authorizationWrapper?: DynamicOAuthAuthorizationWrapper
  identity(value: unknown): { subject: string; displayName: string }
  openapi(input: { resource: string; issuer: string }): Record<string, unknown>
  manifest: Readonly<{
    resourceTypes: readonly string[]
    revocationSignals: readonly string[]
    nativeReadinessGaps: readonly string[]
    retirementCondition: string
  }>
}>

export async function createConfiguredManagedProvider(input: {
  definition: ConfiguredManagedProvider
  origin: string
  db: D1Database
  credentialEncryptionKey: string
  signingPrivateJwk: JWK
  oauthStore: D1ExternalOAuthStore
  replayStore: DpopReplayStore
  audit(record: Record<string, unknown>): Promise<void>
  fetcher?: typeof fetch
}): Promise<AdapterModule[]> {
  const { definition } = input
  const resource = `${input.origin}/${definition.id}`
  const issuer = `${input.origin}/oauth/${definition.id}`
  const credentials = new D1ManagedOAuthCredentials(
    definition.id,
    definition.name,
    input.db,
    createCredentialCipher(input.credentialEncryptionKey),
  )
  const provider = createDynamicOAuthClient({
    providerId: definition.id,
    clientName: definition.clientName,
    endpoints: definition.endpoints,
    redirectUri: `${issuer}/provider/callback`,
    scopes: definition.providerScopes,
    ...(definition.authorizationScopeSeparator
      ? { authorizationScopeSeparator: definition.authorizationScopeSeparator }
      : {}),
    ...(definition.authorizationWrapper ? { authorizationWrapper: definition.authorizationWrapper } : {}),
    registrationStore: new D1DynamicOAuthRegistrationStore(input.db),
    ...(input.fetcher ? { fetcher: input.fetcher } : {}),
  })
  const authorization = await createExternalAuthorizationServer({
    origin: input.origin,
    provider: createManagedOAuthExternalAuthorization({
      id: definition.id,
      name: definition.name,
      origin: input.origin,
      agentScopes: Object.keys(definition.agentScopes),
      providerScopes: definition.providerScopes,
      provider,
      credentials,
      identity: definition.identity,
    }),
    store: input.oauthStore,
    signingPrivateJwk: input.signingPrivateJwk,
    replayStore: input.replayStore,
  })
  const adapter = createManagedOpenApiAdapter(
    {
      id: definition.id,
      resource,
      issuer,
      upstreamOrigin: definition.upstreamOrigin,
      scopes: definition.agentScopes,
      operations: definition.operations,
      openapi: definition.openapi({ resource, issuer }),
      representation: { upstream: definition.id, operationMode: 'configured-openapi' },
      manifest: {
        schemaVersion: '0.1',
        provider: definition.id,
        status: 'experimental',
        identity: {
          level: 'provider-delegated',
          visibleInProduct: false,
          visibleInAuditLog: false,
          attribution: 'audit-only',
        },
        actorModes: ['oauth-delegated-user'],
        credentialModes: ['adapter-dynamic-public-oauth'],
        resourceTypes: definition.manifest.resourceTypes,
        scopes: Object.fromEntries(
          Object.keys(definition.agentScopes).map((scope) => [
            scope,
            { providerPermissions: { oauthScope: definition.providerScopes.join(' ') } },
          ]),
        ),
        operations: definition.operations,
        revocationSignals: definition.manifest.revocationSignals,
        nativeReadinessGaps: definition.manifest.nativeReadinessGaps,
        retirementCondition: definition.manifest.retirementCondition,
      },
    },
    {
      authenticator: authorization.authenticator,
      audit: input.audit,
      ...(input.fetcher ? { fetch: input.fetcher } : {}),
      credential: createManagedOAuthCredentialSource({
        agentScopes: Object.keys(definition.agentScopes),
        providerScopes: definition.providerScopes,
        provider,
        credentials,
      }),
    },
  )
  return [authorization, adapter]
}
