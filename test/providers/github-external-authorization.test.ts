import { Hono } from 'hono'
import { describe, expect, it, vi } from 'vitest'
import type { D1ExternalOAuthStore, ExternalOAuthIntent } from '../../src/core/external-oauth-store.js'
import { GITHUB_INSTALLATION_AUTHORIZATION_DETAIL_TYPE } from '../../src/providers/github/authorization-details.js'
import type { D1GitHubConnections } from '../../src/providers/github/connections.js'
import { createGitHubExternalAuthorization } from '../../src/providers/github/external-authorization.js'
import type { GitHubInstallation } from '../../src/providers/github/types.js'

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
      htmlUrl: 'https://github.com/organizations/realmroot/settings/installations/701',
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
        permissionUpdateUrl: vi.fn((installation: GitHubInstallation) => `${installation.htmlUrl}/permissions/update`),
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

  it('returns the complete installation snapshot after a concrete connection request', async () => {
    const selected = githubInstallation({ administration: 'write' })
    const other = {
      ...selected,
      id: 702,
      htmlUrl: 'https://github.com/settings/installations/702',
      accountLogin: 'controller',
      targetType: 'User',
    }
    const external = createGitHubExternalAuthorization({
      origin: 'https://adapter.example',
      connection: githubConnection([selected, other]),
      connections: {
        upsertExternalAuthorization: vi.fn(async () => [connectionContext(selected), connectionContext(other)]),
      } as unknown as D1GitHubConnections,
      oauthStore: {} as D1ExternalOAuthStore,
      scopes: ['administration:read'],
    })

    await expect(
      external.authorization.complete({
        callbackUrl: 'https://adapter.example/github/oauth/callback?code=provider-code',
        intent: {
          ...intent(),
          scopes: ['administration:read', 'openid'],
          authorizationDetails: [
            { type: GITHUB_INSTALLATION_AUTHORIZATION_DETAIL_TYPE, installation_id: String(selected.id) },
          ],
        },
        nextProviderState: () => 'next-state',
      }),
    ).resolves.toMatchObject({
      type: 'complete',
      grant: {
        authorizationDetails: [
          expect.objectContaining({
            type: GITHUB_INSTALLATION_AUTHORIZATION_DETAIL_TYPE,
            installation_id: String(selected.id),
          }),
          expect.objectContaining({
            type: GITHUB_INSTALLATION_AUTHORIZATION_DETAIL_TYPE,
            installation_id: String(other.id),
          }),
        ],
      },
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
      stage: 'permission-update',
      data: {
        expectedInstallationId: 701,
        permissionUpdateUrl: 'https://github.com/organizations/realmroot/settings/installations/701/permissions/update',
        subject: '70',
        displayName: 'Controller',
      },
      url: 'https://adapter.example/github/permission-update?state=permission-update-state',
    })
    expect(connection.newInstallationUrl).not.toHaveBeenCalled()
    expect(connections.upsertExternalAuthorization).not.toHaveBeenCalled()
  })

  it('[spec: github-adapter/github-installation-permission-upgrade] resumes only after the target installation accepts the permission', async () => {
    const before = githubInstallation({ administration: 'read' })
    const after = githubInstallation({ administration: 'write' })
    const other = {
      ...after,
      id: 702,
      htmlUrl: 'https://github.com/settings/installations/702',
      accountLogin: 'controller',
      targetType: 'User',
    }
    const externalAuthorization = vi
      .fn()
      .mockResolvedValueOnce({ scopes: ['administration:read'], contexts: [connectionContext(before)] })
      .mockResolvedValueOnce({
        scopes: ['administration:read', 'administration:write'],
        contexts: [connectionContext(after), connectionContext(other)],
      })
    const external = createGitHubExternalAuthorization({
      origin: 'https://adapter.example',
      connection: githubConnection([before]),
      connections: { externalAuthorization } as unknown as D1GitHubConnections,
      oauthStore: {} as D1ExternalOAuthStore,
      scopes: ['administration:read', 'administration:write'],
    })
    const permissionUpdateIntent = {
      ...intent(),
      scopes: ['administration:write', 'openid'],
      authorizationDetails: [{ type: GITHUB_INSTALLATION_AUTHORIZATION_DETAIL_TYPE, installation_id: '701' }],
      providerStage: 'permission-update',
      providerData: { expectedInstallationId: 701, subject: '70', displayName: 'Controller' },
    }

    await expect(external.authorization.resume?.({ intent: permissionUpdateIntent })).resolves.toEqual({
      type: 'pending',
    })
    await expect(external.authorization.resume?.({ intent: permissionUpdateIntent })).resolves.toEqual({
      type: 'complete',
      grant: {
        subject: '70',
        displayName: 'Controller',
        scopes: ['administration:write', 'openid'],
        authorizationDetails: [
          expect.objectContaining({
            type: GITHUB_INSTALLATION_AUTHORIZATION_DETAIL_TYPE,
            installation_id: '701',
          }),
          expect.objectContaining({
            type: GITHUB_INSTALLATION_AUTHORIZATION_DETAIL_TYPE,
            installation_id: '702',
          }),
        ],
      },
    })
  })

  it('[spec: github-adapter/github-installation-permission-upgrade] opens the exact installation permission review and polls the preserved intent', async () => {
    const oauthStore = {
      intentByProviderState: vi.fn(async () => ({
        ...intent(),
        providerStage: 'permission-update',
        providerData: {
          expectedInstallationId: 701,
          permissionUpdateUrl:
            'https://github.com/organizations/realmroot/settings/installations/701/permissions/update',
          subject: '70',
          displayName: 'Controller',
        },
      })),
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

    const response = await app.request('https://adapter.example/github/permission-update?state=permission-update-state')

    expect(response.status).toBe(200)
    expect(response.headers.get('cache-control')).toBe('no-store')
    await expect(response.text()).resolves.toContain(
      'https://github.com/organizations/realmroot/settings/installations/701/permissions/update',
    )
  })
})

function githubInstallation(permissions: Record<string, 'read' | 'write'>) {
  return {
    id: 701,
    htmlUrl: 'https://github.com/organizations/realmroot/settings/installations/701',
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
    permissionUpdateUrl: vi.fn(
      (installation: ReturnType<typeof githubInstallation>) => `${installation.htmlUrl}/permissions/update`,
    ),
  }
}

function connectionContext(installation: ReturnType<typeof githubInstallation>) {
  const permissions = installation.permissions as Record<string, 'read' | 'write'>
  return {
    installationId: installation.id,
    accountLogin: installation.accountLogin,
    targetType: installation.targetType,
    scopes:
      permissions.administration === 'write'
        ? ['administration:read', 'administration:write', 'metadata:read']
        : ['administration:read', 'metadata:read'],
    repositorySelection: installation.repositorySelection,
    repositories: [],
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
