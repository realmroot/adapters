import { describe, expect, it, vi } from 'vitest'
import { createApp } from '../src/app.js'
import type { AppConfig } from '../src/config.js'
import type { IdempotencyStore } from '../src/core/idempotency.js'
import { adapterApiVersion } from '../src/providers/github/openapi.js'
import type { GitHubConnectionStore } from '../src/storage/d1-github-connections.js'

const config: AppConfig = {
  origin: 'http://127.0.0.1:4103',
  realmrootIssuer: 'http://127.0.0.1:4189/api/auth',
  realmrootJwksUrl: 'http://127.0.0.1:4189/api/auth/jwks',
  githubApiOrigin: 'https://api.github.com',
  githubAppId: '123',
}

const principal = {
  subject: 'org_1',
  issuer: config.realmrootIssuer,
  actor: { issuer: config.realmrootIssuer, subject: 'agt_1', profile: 'ai_agent' as const },
  scopes: new Set(['github:metadata:read', 'github:issues:write']),
  connectionId: 'connection-1',
  authorizationDetails: [],
}

describe('GitHub adapter contract', () => {
  it('[spec: github-adapter/github-contract] publishes one GitHub Resource Server and broker metadata', async () => {
    const app = testApp()
    const metadata = await app.request('/.well-known/oauth-protected-resource/github')
    expect(await metadata.json()).toMatchObject({
      resource: 'http://127.0.0.1:4103/github',
      authorization_servers: [config.realmrootIssuer],
      scopes_supported: ['github:metadata:read', 'github:issues:write'],
      account_connection_modes_supported: ['brokered'],
      account_connection_revocation_endpoint: 'http://127.0.0.1:4103/github/account-connection-revocations',
    })
    const resource = await app.request('/github')
    expect(resource.headers.get('link')).toContain('rel="service-desc"')
    const openapi = await app.request('/github/openapi.json')
    const contract = (await openapi.json()) as { paths: Record<string, unknown> }
    expect(contract.paths).toHaveProperty('/repositories')
    expect(contract.paths).toHaveProperty('/repos/{owner}/{repository}/issues')
  })

  it('[spec: github-adapter/github-provider-revocation] accepts a signed one-use broker revocation', async () => {
    const revoke = vi.fn(async () => {})
    const app = testApp({
      revocationRequestVerifier: vi.fn(async () => ({
        sub: 'org_1',
        jti: 'revocation-1',
        exp: 1_800_000_060,
        connection_id: 'provider-connection-1',
        resource_authorization_id: 'resource-authorization-1',
        broker_reference: 'broker-1',
      })),
      githubConnections: { ...fakeGitHubConnections(), revoke },
    })
    const response = await app.request('/github/account-connection-revocations', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ request: 'signed-revocation' }),
    })

    expect(response.status).toBe(204)
    expect(revoke).toHaveBeenCalledWith({
      brokerReference: 'broker-1',
      ownerSubject: 'org_1',
      jti: 'revocation-1',
      expiresAt: 1_800_000_060_000,
    })
  })

  it('[spec: github-adapter/github-provider-connection] completes authorization and returns only broker metadata', async () => {
    const store = fakeGitHubConnections()
    const intent = {
      requestId: 'request-1',
      connectionId: 'provider-connection-1',
      expectedExternalSubject: null,
      ownerSubject: 'org_1',
      realmrootState: 'realmroot-state',
      callbackUri: 'https://id.example/api/account-connections/oauth/callback',
      codeChallenge: 'challenge',
      scopesJson: '["github:metadata:read"]',
      expectedInstallationId: null,
      status: 'pending_oauth' as const,
      expiresAt: Date.now() + 60_000,
    }
    store.findByProviderState = vi.fn(async () => intent)
    store.exchange = vi.fn(async () => ({
      intent: { ...intent, status: 'completed' as const },
      brokerReference: 'broker-1',
      binding: {
        githubUserId: 7,
        githubLogin: 'controller',
        displayName: 'Controller',
        scopesJson: '["github:metadata:read"]',
      },
      contexts: [{ installationId: 42, accountLogin: 'realmroot', targetType: 'Organization' }],
    }))
    const app = testApp({
      connectionRequestVerifier: vi.fn(async () => ({
        sub: 'org_1',
        jti: 'request-1',
        state: 'realmroot-state',
        connection_id: 'provider-connection-1',
        expected_external_subject: null,
        owner_type: 'organization' as const,
        callback_uri: intent.callbackUri,
        code_challenge: 'a'.repeat(43),
        code_challenge_method: 'S256' as const,
        scope: 'github:metadata:read',
        authorization_details: [{ type: 'github_installation' }],
      })),
      githubConnection: {
        authorizationUrl: vi.fn(() => 'https://github.com/login/oauth/authorize?state=provider-state'),
        exchangeUserCode: vi.fn(async () => 'user-token'),
        getUser: vi.fn(async () => ({ id: 7, login: 'controller', name: 'Controller' })),
        listUserInstallations: vi.fn(async () => [{ id: 42, accountLogin: 'realmroot', targetType: 'Organization' }]),
        newInstallationUrl: vi.fn(),
      },
      githubConnections: store,
    })

    const authorization = await app.request('/github/account-connection-authorizations?request=signed-request')
    expect(authorization.status).toBe(302)
    expect(authorization.headers.get('location')).toContain('github.com/login/oauth/authorize')
    expect(store.create).toHaveBeenCalledWith(expect.objectContaining({ sub: 'org_1' }), expect.any(String))

    const callback = await app.request('/github/oauth/callback?state=provider-state&code=github-code')
    expect(callback.status).toBe(302)
    expect(callback.headers.get('location')).toContain(`${intent.callbackUri}?state=realmroot-state&code=`)
    expect(store.complete).toHaveBeenCalledWith(
      intent,
      expect.objectContaining({ id: 7 }),
      [expect.objectContaining({ id: 42 })],
      expect.any(String),
    )

    const credentials = await app.request('/github/account-connection-credentials', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ code: 'adapter-code', code_verifier: 'verifier', connection_id: 'request-1' }),
    })
    expect(credentials.status).toBe(200)
    await expect(credentials.json()).resolves.toMatchObject({
      external_subject: '7',
      broker_reference: 'broker-1',
      authorization_details: [{ type: 'github_installation', installation_id: '42' }],
    })
    expect(store.exchange).toHaveBeenCalledWith('adapter-code', 'verifier', 'request-1')
  })

  it('records one structured completion event for success and unexpected failure', async () => {
    const info = vi.spyOn(console, 'info').mockImplementation(() => {})
    const error = vi.spyOn(console, 'error').mockImplementation(() => {})
    try {
      expect((await testApp().request('/health')).status).toBe(200)
      expect(info).toHaveBeenCalledOnce()
      expect(JSON.parse(String(info.mock.calls[0]?.[0]))).toMatchObject({
        event: 'request.complete',
        method: 'GET',
        path: '/health',
        status: 200,
      })

      const failed = testApp({
        githubConnections: {
          ...fakeGitHubConnections(),
          activeInstallationIdsForOwner: vi.fn(async () => {
            throw new Error('storage unavailable')
          }),
        },
      })
      expect((await failed.request('/github/repositories')).status).toBe(500)
      expect(error).toHaveBeenCalledOnce()
      expect(JSON.parse(String(error.mock.calls[0]?.[0]))).toMatchObject({
        event: 'request.complete',
        status: 500,
        failure: { type: 'about:blank', error: { message: 'storage unavailable' } },
      })
    } finally {
      info.mockRestore()
      error.mockRestore()
    }
  })

  it('[spec: github-adapter/github-create-issue] injects attribution, audits, and replays one write', async () => {
    const createIssue = vi.fn(async (input) => ({
      id: 1,
      number: 2,
      title: input.title,
      body: input.body,
      state: 'open',
      htmlUrl: 'https://github.test/issues/2',
    }))
    const audit = vi.fn(async () => {})
    const app = testApp({
      github: {
        listRepositories: vi.fn(async () => ({
          items: [
            {
              id: 1,
              name: 'example',
              fullName: 'realmroot/example',
              private: false,
              htmlUrl: 'https://github.test/realmroot/example',
              owner: 'realmroot',
            },
          ],
          total: 1,
        })),
        createIssue,
      },
      audit,
    })
    const request = () =>
      app.request('/github/repos/realmroot/example/issues', {
        method: 'POST',
        headers: { 'API-Version': adapterApiVersion, 'Idempotency-Key': 'issue-1', 'Content-Type': 'application/json' },
        body: JSON.stringify({ title: 'Adapter test', body: 'Original' }),
      })

    expect((await request()).status).toBe(201)
    expect((await request()).status).toBe(201)
    expect(createIssue).toHaveBeenCalledOnce()
    expect(createIssue.mock.calls[0]?.[0].body).toContain('Created by [Build Agent]')
    expect(createIssue.mock.calls[0]?.[0].body).toContain('<!-- realmroot-agent:')
    expect(audit).toHaveBeenCalledOnce()
  })

  it('[spec: github-adapter/github-reserved-attribution] rejects forged attribution before GitHub', async () => {
    const createIssue = vi.fn()
    const app = testApp({ github: { listRepositories: vi.fn(), createIssue } })
    const response = await app.request('/github/repos/realmroot/example/issues', {
      method: 'POST',
      headers: { 'API-Version': adapterApiVersion, 'Idempotency-Key': 'issue-2', 'Content-Type': 'application/json' },
      body: JSON.stringify({ title: 'Forged', body: '<!-- realmroot-agent: fake -->' }),
    })
    expect(response.status).toBe(400)
    expect(response.headers.get('content-type')).toContain('application/problem+json')
    expect(createIssue).not.toHaveBeenCalled()
  })

  it('[spec: github-adapter/github-repositories] authenticates, paginates, and exposes no provider credential', async () => {
    const app = testApp({
      github: {
        listRepositories: vi.fn(async () => ({
          items: [
            {
              id: 1,
              name: 'one',
              fullName: 'realmroot/one',
              private: true,
              htmlUrl: 'https://github.test/realmroot/one',
              owner: 'realmroot',
            },
            {
              id: 2,
              name: 'two',
              fullName: 'realmroot/two',
              private: false,
              htmlUrl: 'https://github.test/realmroot/two',
              owner: 'realmroot',
            },
          ],
          total: 2,
        })),
        createIssue: vi.fn(),
      },
    })
    const response = await app.request('/github/repositories?page=1&perPage=1', {
      headers: { 'API-Version': adapterApiVersion },
    })
    expect(response.status).toBe(200)
    expect(response.headers.get('link')).toContain('page=2')
    expect(JSON.stringify(await response.json())).not.toContain('token')
  })

  it('returns correlated Problem Details for version, authorization, route, and input failures', async () => {
    const defaultVersion = await testApp().request('/github/repositories')
    expect(defaultVersion.status).toBe(200)
    expect(defaultVersion.headers.get('request-id')).toBeTruthy()
    const unsupportedVersion = await testApp().request('/github/repositories', {
      headers: { 'API-Version': '2026-01-01' },
    })
    expect(unsupportedVersion.status).toBe(400)

    const denied = testApp({
      authenticator: { authenticate: vi.fn(async () => ({ ...principal, scopes: new Set<string>() })) },
    })
    expect(
      (
        await denied.request('/github/repositories', {
          headers: { 'API-Version': adapterApiVersion },
        })
      ).status,
    ).toBe(403)
    expect((await testApp().request('/missing')).status).toBe(404)
    const malformed = await testApp().request('/github/repos/realmroot/example/issues', {
      method: 'POST',
      headers: {
        'API-Version': adapterApiVersion,
        'Idempotency-Key': 'issue-3',
        'Content-Type': 'application/json',
      },
      body: '{',
    })
    expect(malformed.status).toBe(400)
  })

  it('keeps discovery available but fails provider operations when GitHub credentials are absent', async () => {
    const app = createApp(config, {
      authenticator: { authenticate: vi.fn(async () => principal) },
      idempotency: new FakeIdempotencyStore(),
      agentInfo: {
        resolve: vi.fn(async () => ({
          name: 'Build Agent',
          picture: 'https://id.test/a.png',
          identityUrl: 'https://id.test/agentinfo?sub=agt_1',
        })),
      },
      githubConnections: fakeGitHubConnections(),
      audit: vi.fn(async () => {}),
    })
    const list = await app.request('/github/repositories', {
      headers: { 'API-Version': adapterApiVersion },
    })
    expect(list.status).toBe(503)

    const create = await app.request('/github/repos/realmroot/example/issues', {
      method: 'POST',
      headers: {
        'API-Version': adapterApiVersion,
        'Idempotency-Key': 'issue-4',
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ title: 'No credentials' }),
    })
    expect(create.status).toBe(503)
  })
})

function testApp(overrides: Partial<Parameters<typeof createApp>[1]> = {}) {
  return createApp(config, {
    authenticator: { authenticate: vi.fn(async () => principal) },
    agentInfo: {
      resolve: vi.fn(async () => ({
        name: 'Build Agent',
        picture: 'https://id.test/a.png',
        identityUrl: 'https://id.test/agentinfo?sub=agt_1',
      })),
    },
    github: {
      listRepositories: vi.fn(async () => ({ items: [], total: 0 })),
      createIssue: vi.fn(),
    },
    idempotency: new FakeIdempotencyStore(),
    githubConnections: fakeGitHubConnections(),
    audit: vi.fn(async () => {}),
    ...overrides,
  })
}

function fakeGitHubConnections(): GitHubConnectionStore {
  return {
    create: vi.fn(async () => {}),
    findByProviderState: vi.fn(),
    rotateProviderState: vi.fn(async () => {}),
    complete: vi.fn(async () => {}),
    exchange: vi.fn(),
    activeInstallationIdsForOwner: vi.fn(async () => [42]),
    revoke: vi.fn(async () => {}),
  }
}

class FakeIdempotencyStore implements IdempotencyStore {
  readonly responses = new Map<string, Response>()

  async execute(key: string | null, namespace: string, _input: unknown, operation: () => Promise<Response>) {
    if (!key) throw new Error('Idempotency-Key is required.')
    const storageKey = `${namespace}:${key}`
    const stored = this.responses.get(storageKey)
    if (stored) return stored.clone()
    const response = await operation()
    this.responses.set(storageKey, response.clone())
    return response
  }
}
