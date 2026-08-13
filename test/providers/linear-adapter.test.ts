import { describe, expect, it, vi } from 'vitest'
import { createApp } from '../../src/app.js'
import type { RealmrootTokenExchangeClient } from '../../src/core/oauth-client.js'
import type { RealmrootAuthenticator } from '../../src/core/realmroot-auth.js'
import { createLinearAdapter } from '../../src/providers/linear/adapter.js'
import type { LinearAdapterConfig } from '../../src/providers/linear/config.js'

describe('Linear adapter', () => {
  it('[spec: linear-adapter/linear-contract] publishes a Realmroot-managed Resource Server contract', async () => {
    const { app } = createLinearApp()
    const metadata = await app.request('/.well-known/oauth-protected-resource/linear')
    expect(await metadata.json()).toEqual({
      resource: 'https://adapter.example/linear',
      authorization_servers: ['https://id.example/api/auth'],
      scopes_supported: expect.arrayContaining(['read', 'write', 'app:mentionable']),
      authorization_details_types_supported: ['linear_workspace'],
      bearer_methods_supported: ['header'],
    })
    const contract = await app.request('/linear/openapi.json')
    expect(contract.headers.get('content-type')).toContain('application/vnd.oai.openapi+json')
    expect(await contract.json()).toMatchObject({
      servers: [{ url: 'https://adapter.example/linear' }],
      paths: { '/graphql': { post: { 'x-realmroot-dynamic-scope-evaluation': true } } },
    })
    await expect((await app.request('/providers/linear/manifest')).json()).resolves.toMatchObject({
      provider: 'linear',
      credentialModes: ['realmroot-connector-oauth'],
      operations: { mode: 'transparent' },
    })
  })

  it('[spec: linear-adapter/linear-transparent-graphql] exchanges the Agent token and injects display fields', async () => {
    const { app, exchange, upstream } = createLinearApp()
    const response = await app.request('/linear/graphql', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        query: 'mutation Create($input: IssueCreateInput!) { issueCreate(input: $input) { success } }',
        variables: { input: { title: 'Linear adapter', teamId: 'team-1' } },
      }),
    })
    expect(response.status).toBe(207)
    await expect(response.json()).resolves.toEqual({ data: { issueCreate: { success: true } }, errors: [] })
    expect(exchange.exchange).toHaveBeenCalledWith({
      subjectToken: 'realmroot-agent-token',
      audience: 'https://adapter.example/linear',
      scopes: ['issues:create'],
    })
    const call = vi.mocked(upstream).mock.calls[0]
    if (!call) throw new Error('Expected a Linear upstream request.')
    const [target, init] = call
    expect(target.toString()).toBe('https://api.linear.app/graphql')
    expect(new Headers(init?.headers).get('authorization')).toBe('Bearer linear-access')
    const forwarded = JSON.parse(String(init?.body))
    expect(forwarded.variables.input).toMatchObject({
      createAsUser: 'Mac Agent',
      displayIconUrl: 'https://id.example/agents/mac.png',
    })
  })

  it('[spec: linear-adapter/linear-transparent-graphql] rejects a provider grant missing approved scopes', async () => {
    const exchange: RealmrootTokenExchangeClient = {
      exchange: vi.fn(async () => ({ accessToken: 'linear-access', expiresIn: 60, scopes: new Set<string>() })),
    }
    const { app, upstream } = createLinearApp(exchange)
    const response = await app.request('/linear/graphql', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ query: 'query { viewer { id } }' }),
    })
    expect(response.status).toBe(403)
    expect(upstream).not.toHaveBeenCalled()
  })
})

function createLinearApp(exchangeOverride?: RealmrootTokenExchangeClient) {
  const authenticator: RealmrootAuthenticator = {
    authenticate: vi.fn(async () => ({
      subject: 'owner-1',
      issuer: 'https://id.example/api/auth',
      actor: { issuer: 'https://id.example/api/auth', subject: 'agent-1', profile: 'ai_agent' as const },
      scopes: new Set(['issues:create']),
      connectionId: 'connection-1',
      authorizationDetails: [],
      subjectToken: 'realmroot-agent-token',
    })),
  }
  const exchange =
    exchangeOverride ??
    ({
      exchange: vi.fn(async () => ({
        accessToken: 'linear-access',
        expiresIn: 60,
        scopes: new Set(['issues:create']),
      })),
    } satisfies RealmrootTokenExchangeClient)
  const upstream: typeof fetch = vi.fn(async (_input: RequestInfo | URL, _init?: RequestInit) =>
    Response.json(
      { data: { issueCreate: { success: true } }, errors: [] },
      { status: 207, headers: { 'x-linear-request-id': 'linear-request-1' } },
    ),
  )
  const app = createApp([
    createLinearAdapter(config(), {
      authenticator,
      exchange,
      fetch: upstream,
      audit: vi.fn(async () => {}),
      agentInfo: {
        resolve: vi.fn(async () => ({
          name: 'Mac Agent',
          picture: 'https://id.example/agents/mac.png',
          identityUrl: 'https://id.example/agents/agent-1',
        })),
      },
    }),
  ])
  return { app, exchange, upstream }
}

function config(): LinearAdapterConfig {
  return {
    origin: 'https://adapter.example',
    realmrootIssuer: 'https://id.example/api/auth',
    realmrootJwksUrl: 'https://id.example/api/auth/jwks',
    realmrootAgentProfileUriTemplate: 'https://id.example/api/public/agents/{subject}',
    linearApiOrigin: 'https://api.linear.app',
    applicationClientId: 'adapter-client',
    applicationClientSecret: 'adapter-secret',
  }
}
