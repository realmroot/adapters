import { createHmac } from 'node:crypto'
import { describe, expect, it, vi } from 'vitest'
import { createApp } from '../../src/app.js'
import type { RealmrootAuthenticator } from '../../src/core/realmroot-auth.js'
import { createLinearAdapter } from '../../src/providers/linear/adapter.js'
import type { LinearAdapterConfig } from '../../src/providers/linear/config.js'
import type { LinearConnectionStore } from '../../src/providers/linear/connections.js'
import type { LinearProvider } from '../../src/providers/linear/types.js'

describe('Linear adapter', () => {
  it('[spec: linear-adapter/linear-contract] publishes discovery, manifest, and the transparent GraphQL contract', async () => {
    const app = createLinearApp()
    const metadata = await app.request('/.well-known/oauth-protected-resource/linear')
    expect(await metadata.json()).toMatchObject({
      resource: 'https://adapter.example/linear',
      scopes_supported: expect.arrayContaining(['read', 'write', 'app:mentionable']),
      authorization_details_types_supported: [],
      authorization_servers: ['https://adapter.example/oauth/linear'],
    })
    const contract = await app.request('/linear/openapi.json')
    expect(contract.headers.get('content-type')).toContain('application/vnd.oai.openapi+json')
    expect(await contract.json()).toMatchObject({
      servers: [{ url: 'https://adapter.example/linear' }],
      paths: {
        '/graphql': {
          post: {
            'x-realmroot-dynamic-scope-evaluation': true,
            security: expect.arrayContaining([
              { realmrootRead: ['read'] },
              { realmrootIssuesCreate: ['issues:create'] },
              { realmrootCustomerRead: ['customer:read'] },
            ]),
          },
        },
      },
      components: {
        securitySchemes: {
          realmrootRead: expect.objectContaining({ type: 'openIdConnect' }),
          realmrootIssuesCreate: expect.objectContaining({ type: 'openIdConnect' }),
        },
      },
    })
    await expect((await app.request('/providers/linear/manifest')).json()).resolves.toMatchObject({
      provider: 'linear',
      identity: { level: 'provider-delegated', attribution: 'provider-native' },
      operations: { mode: 'transparent' },
    })
  })

  it('[spec: linear-adapter/linear-transparent-graphql] proxies Linear and injects native Agent display fields', async () => {
    const provider = fakeProvider()
    const connections = fakeConnections()
    const app = createLinearApp({ provider, connections })
    const response = await app.request('/linear/graphql', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        query: 'mutation Create($input: IssueCreateInput!) { issueCreate(input: $input) { success } }',
        variables: { input: { title: 'Linear adapter', teamId: 'team-1' } },
      }),
    })
    expect(response.status).toBe(207)
    expect(response.headers.get('x-linear-request-id')).toBe('linear-request-1')
    await expect(response.json()).resolves.toEqual({ data: { issueCreate: { success: true } }, errors: [] })
    const request = vi.mocked(provider.request).mock.calls[0]?.[0]
    if (!request) throw new Error('Expected Linear to receive a forwarded request.')
    const forwarded = JSON.parse(await request.text())
    expect(forwarded.variables.input).toMatchObject({
      createAsUser: 'Mac Agent',
      displayIconUrl: 'https://id.example/agents/mac.png',
    })
  })

  it('[spec: linear-adapter/linear-provider-lifecycle] applies a signed permission webhook exactly once', async () => {
    const now = Date.now()
    const payload = JSON.stringify({
      type: 'PermissionChange',
      action: 'teamAccessChanged',
      organizationId: 'workspace-1',
      oauthClientId: 'linear-client',
      appUserId: 'app-user-1',
      canAccessAllPublicTeams: false,
      addedTeamIds: ['team-1'],
      removedTeamIds: [],
      webhookTimestamp: now,
      webhookId: 'delivery-1',
    })
    const signature = createHmac('sha256', 'linear-webhook-secret').update(payload).digest('hex')
    const connections = fakeConnections()
    const response = await createLinearApp({ connections }).request('/linear/webhooks', {
      method: 'POST',
      headers: {
        'linear-signature': signature,
        'linear-timestamp': String(now),
        'linear-delivery': 'delivery-1',
      },
      body: payload,
    })
    expect(response.status).toBe(204)
    expect(connections.applyLifecycleWebhook).toHaveBeenCalledWith(
      'delivery-1',
      expect.any(Number),
      expect.objectContaining({ type: 'team-access-changed', workspaceId: 'workspace-1', addedTeamIds: ['team-1'] }),
    )
  })
})

function createLinearApp(overrides: { provider?: LinearProvider; connections?: LinearConnectionStore } = {}) {
  const authenticator: RealmrootAuthenticator = {
    authenticate: vi.fn(async () => ({
      subject: 'workspace-1',
      issuer: 'https://id.example/api/auth',
      actor: { issuer: 'https://id.example/api/auth', subject: 'agent-1', profile: 'ai_agent' as const },
      scopes: new Set(['issues:create']),
      connectionId: 'connection-1',
      authorizationDetails: [],
    })),
  }
  return createApp([
    createLinearAdapter(config(), {
      authenticator,
      audit: vi.fn(async () => {}),
      agentInfo: {
        resolve: vi.fn(async () => ({
          name: 'Mac Agent',
          picture: 'https://id.example/agents/mac.png',
          identityUrl: 'https://id.example/agents/agent-1',
        })),
      },
      provider: overrides.provider ?? fakeProvider(),
      connections: overrides.connections ?? fakeConnections(),
    }),
  ])
}

function config(): LinearAdapterConfig {
  return {
    origin: 'https://adapter.example',
    realmrootIssuer: 'https://id.example/api/auth',
    realmrootJwksUrl: 'https://id.example/api/auth/jwks',
    realmrootAgentProfileUriTemplate: 'https://id.example/api/public/agents/{subject}',
    linearApiOrigin: 'https://api.linear.app',
    linearAuthorizationOrigin: 'https://linear.app',
    linearClientId: 'linear-client',
    linearClientSecret: 'linear-secret',
    linearCredentialEncryptionKey: 'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA',
    linearWebhookSecret: 'linear-webhook-secret',
  }
}

function fakeProvider(): LinearProvider {
  return {
    authorizationUrl: vi.fn(({ actor, state }) => `https://linear.app/oauth/authorize?actor=${actor}&state=${state}`),
    exchangeCode: vi.fn(async () => ({
      accessToken: 'linear-access',
      refreshToken: 'linear-refresh',
      expiresAt: Date.now() + 60_000,
      scopes: ['read', 'write', 'issues:create', 'comments:create', 'app:assignable', 'app:mentionable'] as const,
    })),
    refresh: vi.fn(),
    revoke: vi.fn(async () => {}),
    viewer: vi.fn(async () => ({
      user: { id: 'linear-user-1', name: 'Jasper Van', email: 'jasper@example.com' },
      workspace: { id: 'workspace-1', name: 'Realmroot', urlKey: 'realmroot', logoUrl: null },
    })),
    request: vi.fn(async () =>
      Response.json(
        { data: { issueCreate: { success: true } }, errors: [] },
        { status: 207, headers: { 'x-linear-request-id': 'linear-request-1' } },
      ),
    ),
  }
}

function fakeConnections(): LinearConnectionStore {
  return {
    create: vi.fn(async () => {}),
    findByProviderState: vi.fn(),
    recordUser: vi.fn(async () => {}),
    complete: vi.fn(async () => {}),
    exchange: vi.fn(async () => ({
      brokerReference: 'connection-1',
      binding: { linearUserId: 'linear-user-1', displayName: 'Jasper Van', scopesJson: '["read","write"]' },
      contexts: [
        {
          workspaceId: 'workspace-1',
          workspaceName: 'Realmroot',
          workspaceUrlKey: 'realmroot',
          appUserId: 'app-user-1',
        },
      ],
    })),
    credentialForOwner: vi.fn(async () => ({
      brokerReference: 'connection-1',
      workspaceId: 'workspace-1',
      workspaceName: 'Realmroot',
      workspaceUrlKey: 'realmroot',
      appUserId: 'app-user-1',
      accessToken: 'linear-access',
      refreshToken: 'linear-refresh',
      tokenExpiresAt: Date.now() + 60_000,
      scopes: ['read', 'write', 'issues:create'],
      credentialVersion: 1,
    })),
    claimRefresh: vi.fn(async () => true),
    replaceCredential: vi.fn(async () => true),
    releaseRefreshClaim: vi.fn(async () => {}),
    credentialsForRevocation: vi.fn(async () => []),
    revoke: vi.fn(async () => {}),
    applyLifecycleWebhook: vi.fn(async () => {}),
  }
}
