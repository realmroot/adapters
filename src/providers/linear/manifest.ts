import type { ProviderManifest } from '../../core/provider.js'
import { linearScopeDescriptions, linearScopes } from './scopes.js'

export const linearManifest = {
  schemaVersion: '0.1',
  provider: 'linear',
  status: 'experimental',
  identity: {
    level: 'brokered',
    visibleInProduct: true,
    visibleInAuditLog: true,
    attribution: 'provider-native',
  },
  actorModes: ['linear-user', 'linear-app-user'],
  credentialModes: ['oauth-app-access-token'],
  resourceTypes: ['workspace', 'team', 'project', 'issue'],
  scopes: Object.fromEntries(
    linearScopes.map((scope) => [scope, { providerPermissions: { [scope]: linearScopeDescriptions[scope] } }]),
  ),
  operations: {
    mode: 'transparent',
    upstream: 'https://api.linear.app/graphql',
    openapi: '/linear/openapi.json',
    transformations: [
      { method: 'POST', path: '/graphql', behavior: 'agent-display-for-issueCreate-and-commentCreate' },
    ],
  },
  revocationSignals: ['realmroot-signed-broker-revocation', 'linear-oauth-app-revoked', 'token-rejection'],
  nativeReadinessGaps: ['ACTOR-CHAIN', 'ACTOR-PROFILE', 'DPOP', 'TOKEN-EXCHANGE'],
  retirementCondition:
    'Linear accepts the stable external Agent and proof-bound authority directly instead of recording the shared Realmroot App user as the security principal.',
} as const satisfies ProviderManifest
