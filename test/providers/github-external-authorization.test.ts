import { describe, expect, it, vi } from 'vitest'
import type { D1ExternalOAuthStore, ExternalOAuthIntent } from '../../src/core/external-oauth-store.js'
import type { D1GitHubConnections } from '../../src/providers/github/connections.js'
import { createGitHubExternalAuthorization } from '../../src/providers/github/external-authorization.js'

describe('GitHub external authorization', () => {
  it('accepts read scopes implied by a write installation permission', async () => {
    const installation = {
      id: 701,
      accountLogin: 'realmroot',
      targetType: 'Organization',
      permissions: { metadata: 'read', pull_requests: 'write' } as const,
      repositorySelection: 'all' as const,
      repositories: [],
      updatedAt: '2027-01-15T07:00:00.000Z',
    }
    const connections = {
      upsertExternalAuthorization: vi.fn(async () => [
        {
          installationId: installation.id,
          accountLogin: installation.accountLogin,
          targetType: installation.targetType,
          scopes: ['metadata:read', 'pull_requests:read', 'pull_requests:write'],
          repositorySelection: installation.repositorySelection,
          repositories: [],
        },
      ]),
    }
    const external = createGitHubExternalAuthorization({
      origin: 'https://adapter.example',
      connection: {
        authorizationUrl: vi.fn(() => 'https://github.com/login/oauth/authorize'),
        exchangeUserCode: vi.fn(async () => 'user-token'),
        getUser: vi.fn(async () => ({ id: 70, login: 'controller', name: 'Controller' })),
        listUserInstallations: vi.fn(async () => [installation]),
        newInstallationUrl: vi.fn(async () => 'https://github.com/apps/example/installations/new'),
      },
      connections: connections as unknown as D1GitHubConnections,
      oauthStore: {} as D1ExternalOAuthStore,
      scopes: ['metadata:read', 'pull_requests:read', 'pull_requests:write'],
    })

    await expect(
      external.authorization.complete({
        callbackUrl: 'https://adapter.example/github/oauth/callback?code=provider-code',
        intent: intent(),
        nextProviderState: () => 'next-state',
      }),
    ).resolves.toMatchObject({
      type: 'complete',
      grant: { scopes: ['metadata:read', 'openid', 'pull_requests:read'] },
    })
  })
})

function intent(): ExternalOAuthIntent {
  return {
    id: 'intent-1',
    providerId: 'github',
    clientId: 'client-1',
    redirectUri: 'https://id.realmroot.dev/oauth/account-connection/callback',
    realmrootState: 'realmroot-state',
    scopes: ['metadata:read', 'openid', 'pull_requests:read'],
    authorizationDetails: [{ type: 'github_installation' }],
    codeChallenge: 'challenge',
    providerStage: 'oauth',
    providerData: {},
    expiresAt: Date.now() + 60_000,
  }
}
