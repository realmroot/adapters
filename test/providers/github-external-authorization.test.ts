import { Hono } from 'hono'
import { describe, expect, it, vi } from 'vitest'
import type { D1ExternalOAuthStore, ExternalOAuthIntent } from '../../src/core/external-oauth-store.js'
import { GITHUB_INSTALLATION_AUTHORIZATION_DETAIL_TYPE } from '../../src/providers/github/authorization-details.js'
import type { D1GitHubConnections } from '../../src/providers/github/connections.js'
import { createGitHubExternalAuthorization } from '../../src/providers/github/external-authorization.js'

describe('GitHub external authorization', () => {
  it('[spec: github-adapter/github-context-catalog] exposes stable installation details with human labels', async () => {
    const contexts = [
      {
        installationId: 701,
        accountLogin: 'realmroot',
        targetType: 'Organization',
        scopes: ['metadata:read'],
        repositorySelection: 'all' as const,
        repositories: [],
      },
    ]
    const external = createGitHubExternalAuthorization({
      origin: 'https://adapter.example',
      connection: {} as never,
      connections: {
        externalAuthorization: vi.fn(async () => ({ scopes: ['metadata:read'], contexts })),
      } as unknown as D1GitHubConnections,
      oauthStore: {} as D1ExternalOAuthStore,
      scopes: ['metadata:read'],
    })

    await expect(
      external.authorization.authorizationDetailsCatalog?.list({ subject: '70', limit: 10, offset: 0 }),
    ).resolves.toEqual({
      items: [
        {
          authorizationDetail: {
            type: GITHUB_INSTALLATION_AUTHORIZATION_DETAIL_TYPE,
            installation_id: '701',
            account_login: 'realmroot',
            target_type: 'Organization',
            repository_selection: 'all',
          },
          grantedScopes: ['metadata:read'],
          display: {
            label: 'realmroot',
            description: 'Organization GitHub App installation',
            metadata: {
              installation_id: '701',
              target_type: 'Organization',
              repository_selection: 'all',
            },
          },
        },
      ],
      pagination: { limit: 10, offset: 0, total: 1, hasMore: false, nextOffset: null },
    })
  })

  it('rejects a scope that another installation grants but the selected installation does not', async () => {
    const contexts = [
      {
        installationId: 701,
        accountLogin: 'saltbo',
        targetType: 'User',
        scopes: ['metadata:read'],
        repositorySelection: 'all' as const,
        repositories: [],
      },
      {
        installationId: 702,
        accountLogin: 'realmroot',
        targetType: 'Organization',
        scopes: ['administration:write', 'metadata:read'],
        repositorySelection: 'all' as const,
        repositories: [],
      },
    ]
    const external = createGitHubExternalAuthorization({
      origin: 'https://adapter.example',
      connection: {} as never,
      connections: {
        externalAuthorization: vi.fn(async () => ({
          scopes: ['administration:write', 'metadata:read'],
          contexts,
        })),
      } as unknown as D1GitHubConnections,
      oauthStore: {} as D1ExternalOAuthStore,
      scopes: ['administration:write', 'metadata:read'],
    })

    await expect(
      external.authorization.validateScopes?.({
        subject: '70',
        scopes: ['administration:write'],
        authorizationDetails: [{ type: GITHUB_INSTALLATION_AUTHORIZATION_DETAIL_TYPE, installation_id: '701' }],
      }),
    ).resolves.toBe(false)
  })

  it('accepts a scope granted by the selected installation after the subject token was issued', async () => {
    const authorizationDetail = {
      type: GITHUB_INSTALLATION_AUTHORIZATION_DETAIL_TYPE,
      installation_id: '701',
    }
    const external = createGitHubExternalAuthorization({
      origin: 'https://adapter.example',
      connection: {} as never,
      connections: {
        externalAuthorization: vi.fn(async () => ({
          scopes: ['metadata:read'],
          contexts: [
            {
              installationId: 701,
              accountLogin: 'saltbo',
              targetType: 'User',
              scopes: ['actions:read', 'metadata:read'],
              repositorySelection: 'all' as const,
              repositories: [],
            },
          ],
        })),
      } as unknown as D1GitHubConnections,
      oauthStore: {} as D1ExternalOAuthStore,
      scopes: ['actions:read', 'metadata:read'],
    })

    await expect(
      external.authorization.validateScopes?.({
        subject: '70',
        scopes: ['actions:read'],
        authorizationDetails: [authorizationDetail],
      }),
    ).resolves.toBe(true)
  })

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

  it('[spec: github-adapter/github-installation-permission-upgrade] continues through a target installation permission update', async () => {
    const installation = githubInstallation({ administration: 'read' })
    const connections = { upsertExternalAuthorization: vi.fn() }
    const connection = githubConnection([installation])
    const external = createGitHubExternalAuthorization({
      origin: 'https://adapter.example',
      connection,
      connections: connections as unknown as D1GitHubConnections,
      oauthStore: {} as D1ExternalOAuthStore,
      scopes: ['administration:read', 'administration:write'],
    })

    await expect(
      external.authorization.complete({
        callbackUrl: 'https://adapter.example/github/oauth/callback?code=provider-code',
        intent: {
          ...intent(),
          scopes: ['administration:write', 'openid'],
          authorizationDetails: [{ type: GITHUB_INSTALLATION_AUTHORIZATION_DETAIL_TYPE, installation_id: '701' }],
        },
        nextProviderState: () => 'permission-update-state',
      }),
    ).resolves.toEqual({
      type: 'continue',
      providerState: 'permission-update-state',
      stage: 'install',
      data: { expectedInstallationId: 701, permissionUpdateAttempted: true },
      url: 'https://github.com/apps/example/installations/new?state=permission-update-state',
    })
    expect(connection.newInstallationUrl).toHaveBeenCalledWith('permission-update-state')
    expect(connections.upsertExternalAuthorization).not.toHaveBeenCalled()
  })

  it('[spec: github-adapter/github-installation-permission-upgrade] stops after one rejected permission update', async () => {
    const connections = { upsertExternalAuthorization: vi.fn() }
    const external = createGitHubExternalAuthorization({
      origin: 'https://adapter.example',
      connection: githubConnection([githubInstallation({ administration: 'read' })]),
      connections: connections as unknown as D1GitHubConnections,
      oauthStore: {} as D1ExternalOAuthStore,
      scopes: ['administration:read', 'administration:write'],
    })

    await expect(
      external.authorization.complete({
        callbackUrl: 'https://adapter.example/github/oauth/callback?code=provider-code',
        intent: {
          ...intent(),
          scopes: ['administration:write', 'openid'],
          providerStage: 'oauth-selected',
          providerData: { expectedInstallationId: 701, permissionUpdateAttempted: true },
        },
        nextProviderState: () => 'must-not-loop',
      }),
    ).resolves.toEqual({
      type: 'error',
      error: 'access_denied',
      description: 'The selected GitHub installation permission update was not approved.',
    })
    expect(connections.upsertExternalAuthorization).not.toHaveBeenCalled()
  })

  it('preserves the permission update intent when GitHub returns through the Setup URL', async () => {
    const oauthStore = {
      intentByProviderState: vi.fn(async () => ({
        ...intent(),
        providerStage: 'install',
        providerData: { expectedInstallationId: 701, permissionUpdateAttempted: true },
      })),
      advanceIntent: vi.fn(async () => undefined),
    }
    const connection = githubConnection([])
    const external = createGitHubExternalAuthorization({
      origin: 'https://adapter.example',
      connection,
      connections: {} as D1GitHubConnections,
      oauthStore: oauthStore as unknown as D1ExternalOAuthStore,
      scopes: ['administration:write'],
    })
    const app = new Hono()
    external.installationCallback.register(app as never)

    const response = await app.request(
      'https://adapter.example/github/account-connection-installations?state=permission-update-state&installation_id=701',
    )

    expect(response.status).toBe(302)
    expect(response.headers.get('location')).toMatch(/^https:\/\/github\.com\/login\/oauth\/authorize\?state=/)
    expect(oauthStore.advanceIntent).toHaveBeenCalledWith({
      id: 'intent-1',
      expectedStage: 'install',
      providerStateHash: expect.any(String),
      providerStage: 'oauth-selected',
      providerData: { expectedInstallationId: 701, permissionUpdateAttempted: true },
    })
  })
})

function githubInstallation(permissions: Record<string, 'read' | 'write'>) {
  return {
    id: 701,
    accountLogin: 'realmroot',
    targetType: 'Organization',
    permissions: { metadata: 'read' as const, ...permissions },
    repositorySelection: 'all' as const,
    repositories: [],
    updatedAt: '2027-01-15T07:00:00.000Z',
  }
}

function githubConnection(installations: ReturnType<typeof githubInstallation>[]) {
  return {
    authorizationUrl: vi.fn((state: string) => `https://github.com/login/oauth/authorize?state=${state}`),
    exchangeUserCode: vi.fn(async () => 'user-token'),
    getUser: vi.fn(async () => ({ id: 70, login: 'controller', name: 'Controller' })),
    listUserInstallations: vi.fn(async () => installations),
    newInstallationUrl: vi.fn(
      async (state: string) => `https://github.com/apps/example/installations/new?state=${state}`,
    ),
  }
}

function intent(): ExternalOAuthIntent {
  return {
    id: 'intent-1',
    providerId: 'github',
    clientId: 'client-1',
    redirectUri: 'https://id.realmroot.dev/oauth/account-connection/callback',
    realmrootState: 'realmroot-state',
    scopes: ['metadata:read', 'openid', 'pull_requests:read'],
    authorizationDetails: [{ type: GITHUB_INSTALLATION_AUTHORIZATION_DETAIL_TYPE }],
    codeChallenge: 'challenge',
    providerStage: 'oauth',
    providerData: {},
    expiresAt: Date.now() + 60_000,
  }
}
