import { describe, expect, it, vi } from 'vitest'
import { createApp } from '../src/app.js'
import type { AppConfig } from '../src/config.js'
import type { IdempotencyStore } from '../src/core/idempotency.js'
import { adapterApiVersion } from '../src/providers/github/openapi.js'

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
}

describe('GitHub adapter contract', () => {
  it('[spec: github-adapter/github-contract] publishes install-specific metadata and OpenAPI discovery', async () => {
    const app = testApp()
    const metadata = await app.request('/.well-known/oauth-protected-resource/github/installations/42')
    expect(await metadata.json()).toMatchObject({
      resource: 'http://127.0.0.1:4103/github/installations/42',
      authorization_servers: [config.realmrootIssuer],
      scopes_supported: ['github:metadata:read', 'github:issues:write'],
    })
    const resource = await app.request('/github/installations/42')
    expect(resource.headers.get('link')).toContain('rel="service-desc"')
    const openapi = await app.request('/github/installations/42/openapi.json')
    const contract = (await openapi.json()) as { paths: Record<string, unknown> }
    expect(contract.paths).toHaveProperty('/repositories')
    expect(contract.paths).toHaveProperty('/repos/{owner}/{repository}/issues')
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
    const app = testApp({ github: { listRepositories: vi.fn(), createIssue }, audit })
    const request = () =>
      app.request('/github/installations/42/repos/realmroot/example/issues', {
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
    const response = await app.request('/github/installations/42/repos/realmroot/example/issues', {
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
          ],
          total: 2,
        })),
        createIssue: vi.fn(),
      },
    })
    const response = await app.request('/github/installations/42/repositories?page=1&perPage=1', {
      headers: { 'API-Version': adapterApiVersion },
    })
    expect(response.status).toBe(200)
    expect(response.headers.get('link')).toContain('page=2')
    expect(JSON.stringify(await response.json())).not.toContain('token')
  })

  it('returns correlated Problem Details for version, authorization, route, and input failures', async () => {
    const missingVersion = await testApp().request('/github/installations/42/repositories')
    expect(missingVersion.status).toBe(400)
    expect(missingVersion.headers.get('request-id')).toBeTruthy()

    const denied = testApp({
      authenticator: { authenticate: vi.fn(async () => ({ ...principal, scopes: new Set<string>() })) },
    })
    expect(
      (
        await denied.request('/github/installations/42/repositories', {
          headers: { 'API-Version': adapterApiVersion },
        })
      ).status,
    ).toBe(403)
    expect((await testApp().request('/missing')).status).toBe(404)
    expect((await testApp().request('/.well-known/oauth-protected-resource/github/installations/nope')).status).toBe(
      400,
    )

    const malformed = await testApp().request('/github/installations/42/repos/realmroot/example/issues', {
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
    })
    const list = await app.request('/github/installations/42/repositories', {
      headers: { 'API-Version': adapterApiVersion },
    })
    expect(list.status).toBe(503)

    const create = await app.request('/github/installations/42/repos/realmroot/example/issues', {
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
    ...overrides,
  })
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
