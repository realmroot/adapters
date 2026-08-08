import type { ProviderManifest } from '../../core/provider.js'
import { permissionsToScopes } from './permissions.js'
import type { GitHubPermissions } from './types.js'

export function githubManifest(permissions: GitHubPermissions) {
  return {
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
    scopes: Object.fromEntries(
      permissionsToScopes(permissions).map((scope) => {
        const [permission, access] = scope.split(':')
        return [scope, { providerPermissions: { [permission as string]: access as string } }]
      }),
    ),
    operations: {
      mode: 'transparent',
      upstream: 'https://api.github.com',
      openapi: '/github/openapi.json',
      transformations: [
        { method: 'POST', path: '/repos/{owner}/{repo}/issues', behavior: 'agent-attribution' },
        {
          method: 'POST',
          path: '/repos/{owner}/{repo}/issues/{issue_number}/comments',
          behavior: 'agent-attribution',
        },
        {
          method: 'POST',
          path: '/repos/{owner}/{repo}/pulls/{pull_number}/comments',
          behavior: 'agent-attribution',
        },
      ],
    },
    revocationSignals: ['realmroot-signed-broker-revocation', 'token-rejection'],
    nativeReadinessGaps: ['ACTOR-NATIVE', 'AGENT-DISPLAY', 'DPOP', 'TOKEN-EXCHANGE'],
    retirementCondition:
      'GitHub authenticates a stable external Agent, authorizes selected repositories and operations, and records that Agent as the native actor.',
  } as const satisfies ProviderManifest
}
