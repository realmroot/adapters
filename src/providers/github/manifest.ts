import type { ProviderManifest } from '../../core/provider.js'

export const githubManifest = {
  schemaVersion: '0.1',
  provider: 'github',
  status: 'alpha',
  identity: {
    level: 'brokered',
    visibleInProduct: true,
    visibleInAuditLog: true,
    attribution: 'content-injection',
  },
  actorModes: ['github-app-installation'],
  credentialModes: ['installation-access-token'],
  resourceTypes: ['installation', 'repository'],
  scopes: {
    'github:metadata:read': { providerPermissions: { metadata: 'read' } },
    'github:issues:write': { providerPermissions: { issues: 'write' } },
  },
  operations: [
    {
      operationId: 'listGitHubRepositories',
      method: 'GET',
      path: '/repositories',
      scope: 'github:metadata:read',
    },
    {
      operationId: 'createGitHubIssue',
      method: 'POST',
      path: '/repos/{owner}/{repository}/issues',
      scope: 'github:issues:write',
    },
  ],
  revocationSignals: ['realmroot-signed-broker-revocation', 'token-rejection'],
  nativeReadinessGaps: ['ACTOR-NATIVE', 'AGENT-DISPLAY', 'DPOP', 'TOKEN-EXCHANGE'],
  retirementCondition:
    'GitHub authenticates a stable external Agent, authorizes selected repositories and operations, and records that Agent as the native actor.',
} as const satisfies ProviderManifest
