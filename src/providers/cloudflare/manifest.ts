import type { ProviderManifest } from '../../core/provider.js'
import { cloudflareOperations } from './operation-permissions.js'

export const cloudflareManifest = {
  schemaVersion: '0.1',
  provider: 'cloudflare',
  status: 'experimental',
  identity: {
    level: 'provider-delegated',
    visibleInProduct: false,
    visibleInAuditLog: false,
    attribution: 'audit-only',
  },
  actorModes: ['oauth-delegated-user'],
  credentialModes: ['adapter-external-oauth'],
  resourceTypes: ['account', 'zone', 'cloudflare-api-resource'],
  scopes: Object.fromEntries(
    [...new Set(cloudflareOperations.flatMap((operation) => operation.scopes))].map((scope) => [
      scope,
      { providerPermissions: { oauthScope: scope } },
    ]),
  ),
  operations: {
    mode: 'transparent',
    upstream: 'https://api.cloudflare.com/client/v4',
    openapi: '/cloudflare/openapi.json',
    transformations: [],
  },
  revocationSignals: ['adapter-oauth-revocation', 'cloudflare-oauth-revocation'],
  nativeReadinessGaps: ['ACTOR-NATIVE', 'AGENT-DISPLAY', 'DPOP'],
  retirementCondition:
    'Cloudflare accepts the stable Realmroot Agent actor and proof-bound delegated authority directly at its API boundary.',
} as const satisfies ProviderManifest
