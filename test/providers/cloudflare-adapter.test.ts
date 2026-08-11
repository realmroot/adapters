import { describe, expect, it, vi } from 'vitest'
import { createApp } from '../../src/app.js'
import type { AgentPrincipal } from '../../src/core/realmroot-auth.js'
import { createCloudflareAdapter } from '../../src/providers/cloudflare/adapter.js'

const resource = 'https://adapters.example/cloudflare'

describe('Cloudflare adapter', () => {
  it('[spec: cloudflare-adapter/cloudflare-native-tool-discovery] advertises Wrangler execution', async () => {
    const { app } = fixture()
    const response = await app.request('/cloudflare')
    await expect(response.json()).resolves.toMatchObject({
      toolIntegrations: [{ id: 'wrangler', executables: ['wrangler', 'npx', 'pnpm'], protocol: 'cloudflare-api-base' }],
    })
  })

  it('[spec: cloudflare-adapter/cloudflare-wrangler-token-verification] verifies Wrangler with one approved scope', async () => {
    const { app, exchange } = fixture({ principal: principal(['dns.write']) })
    const response = await app.request('/cloudflare/user/tokens/verify')
    expect(response.status).toBe(200)
    await expect(response.json()).resolves.toEqual({
      success: true,
      errors: [],
      messages: [],
      result: { id: 'realmroot-agent-authority', status: 'active' },
    })
    expect(exchange).toHaveBeenCalledWith({
      subjectToken: 'realmroot-agent-token',
      audience: resource,
      scopes: ['dns.write'],
    })

    const user = await app.request('/cloudflare/user')
    await expect(user.json()).resolves.toMatchObject({
      success: true,
      result: { id: 'agent-1', email: 'agent-1@agents.realmroot.dev' },
    })
    const memberships = await app.request('/cloudflare/memberships')
    await expect(memberships.json()).resolves.toMatchObject({ success: true, result: [] })
  })

  it('[spec: cloudflare-adapter/cloudflare-wrangler-token-verification] lists accounts with account read authority', async () => {
    const upstream = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const request = input instanceof Request ? input : new Request(input, init)
      expect(request.url).toBe('https://api.cloudflare.com/client/v4/accounts?per_page=50')
      expect(request.headers.get('authorization')).toBe('Bearer provider-access')
      return Response.json({ success: true, result: [{ id: 'account-1', name: 'Realmroot' }] })
    })
    const { app } = fixture({ upstream, principal: principal(['account-settings.read']) })
    const response = await app.request('/cloudflare/accounts?per_page=50')
    expect(response.status).toBe(200)
    await expect(response.json()).resolves.toMatchObject({ result: [{ id: 'account-1', name: 'Realmroot' }] })
  })

  it('publishes protected-resource discovery for proven OAuth scopes', async () => {
    const { app } = fixture()
    const response = await app.request('/.well-known/oauth-protected-resource/cloudflare')
    expect(response.status).toBe(200)
    await expect(response.json()).resolves.toMatchObject({
      resource,
      authorization_servers: ['https://id.example/api/auth'],
    })
  })

  it('exchanges the original Agent token and transparently forwards a scoped write without leaking credentials', async () => {
    const upstream = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const request = input instanceof Request ? input : new Request(input, init)
      expect(request.url).toBe('https://api.cloudflare.com/client/v4/zones/zone-1/dns_records?trace=private')
      expect(request.method).toBe('POST')
      expect(request.headers.get('authorization')).toBe('Bearer provider-access')
      expect(request.headers.get('dpop')).toBeNull()
      expect(request.headers.get('cookie')).toBeNull()
      expect(request.headers.get('x-forwarded-for')).toBeNull()
      expect(request.headers.get('idempotency-key')).toBe('operation-1')
      await expect(request.json()).resolves.toEqual({ type: 'TXT', name: 'proof.example', content: 'ok' })
      return Response.json({ success: true }, { status: 201, headers: { 'CF-Ray': 'ray-1', ETag: 'etag-1' } })
    })
    const { app, audit, exchange } = fixture({ upstream })
    const response = await app.request('/cloudflare/zones/zone-1/dns_records?trace=private', {
      method: 'POST',
      headers: {
        authorization: 'DPoP inbound-secret',
        dpop: 'proof-secret',
        cookie: 'session=secret',
        'x-forwarded-for': '127.0.0.1',
        'idempotency-key': 'operation-1',
        'content-type': 'application/json',
      },
      body: JSON.stringify({ type: 'TXT', name: 'proof.example', content: 'ok' }),
    })
    expect(response.status).toBe(201)
    expect(response.headers.get('cf-ray')).toBe('ray-1')
    expect(exchange).toHaveBeenCalledWith({
      subjectToken: 'realmroot-agent-token',
      audience: resource,
      scopes: ['dns.write'],
    })
    expect(upstream).toHaveBeenCalledTimes(1)
    const auditText = JSON.stringify(audit.mock.calls[0]?.[0])
    expect(auditText).toContain('dns-records-for-a-zone-create-dns-record')
    expect(auditText).not.toContain('realmroot-agent-token')
    expect(auditText).not.toContain('provider-access')
    expect(auditText).not.toContain('trace=private')
    expect(auditText).not.toContain('proof.example')
  })

  it('[spec: cloudflare-adapter/cloudflare-native-tool-discovery] forwards Wrangler service preflight with read authority', async () => {
    const upstream = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const request = input instanceof Request ? input : new Request(input, init)
      expect(request.url).toBe('https://api.cloudflare.com/client/v4/accounts/account-1/workers/services/wallet')
      expect(request.method).toBe('GET')
      return Response.json({ success: true, result: { default_environment: { environment: 'production' } } })
    })
    const { app, exchange } = fixture({ upstream, principal: principal(['workers-scripts.read']) })

    const response = await app.request('/cloudflare/accounts/account-1/workers/services/wallet')

    expect(response.status).toBe(200)
    expect(exchange).toHaveBeenCalledWith({
      subjectToken: 'realmroot-agent-token',
      audience: resource,
      scopes: ['workers-scripts.read'],
    })
    expect(upstream).toHaveBeenCalledTimes(1)
  })

  it('[spec: cloudflare-adapter/cloudflare-native-tool-discovery] forwards Wrangler custom domains with write authority', async () => {
    const upstream = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const request = input instanceof Request ? input : new Request(input, init)
      expect(request.url).toBe(
        'https://api.cloudflare.com/client/v4/accounts/account-1/workers/scripts/wallet/domains/records',
      )
      expect(request.method).toBe('PUT')
      await expect(request.json()).resolves.toEqual([{ hostname: 'wallet.example' }])
      return Response.json({ success: true, result: null })
    })
    const { app, exchange } = fixture({ upstream, principal: principal(['workers-scripts.write']) })

    const response = await app.request('/cloudflare/accounts/account-1/workers/scripts/wallet/domains/records', {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify([{ hostname: 'wallet.example' }]),
    })

    expect(response.status).toBe(200)
    expect(exchange).toHaveBeenCalledWith({
      subjectToken: 'realmroot-agent-token',
      audience: resource,
      scopes: ['workers-scripts.write'],
    })
    expect(upstream).toHaveBeenCalledTimes(1)
  })

  it('[spec: cloudflare-adapter/cloudflare-native-tool-discovery] forwards Wrangler remote preview session creation with write authority', async () => {
    const upstream = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const request = input instanceof Request ? input : new Request(input, init)
      expect(request.url).toBe('https://api.cloudflare.com/client/v4/zones/zone-1/workers/edge-preview')
      expect(request.method).toBe('GET')
      return Response.json({ success: true, result: { token: 'preview-token' } })
    })
    const { app, exchange } = fixture({ upstream, principal: principal(['workers-scripts.write']) })

    const response = await app.request('/cloudflare/zones/zone-1/workers/edge-preview')

    expect(response.status).toBe(200)
    expect(exchange).toHaveBeenCalledWith({
      subjectToken: 'realmroot-agent-token',
      audience: resource,
      scopes: ['workers-scripts.write'],
    })
    expect(upstream).toHaveBeenCalledTimes(1)
  })

  it('[spec: cloudflare-adapter/cloudflare-native-tool-discovery] forwards Wrangler remote preview upload with write authority', async () => {
    const upstream = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const request = input instanceof Request ? input : new Request(input, init)
      expect(request.url).toBe(
        'https://api.cloudflare.com/client/v4/accounts/account-1/workers/scripts/wallet/edge-preview',
      )
      expect(request.method).toBe('POST')
      expect(request.headers.get('cf-preview-upload-config-token')).toBe('preview-session')
      return Response.json({ success: true, result: { preview_token: 'preview-token' } })
    })
    const { app, exchange } = fixture({ upstream, principal: principal(['workers-scripts.write']) })

    const response = await app.request('/cloudflare/accounts/account-1/workers/scripts/wallet/edge-preview', {
      method: 'POST',
      headers: { 'cf-preview-upload-config-token': 'preview-session' },
      body: 'preview bundle',
    })

    expect(response.status).toBe(200)
    expect(exchange).toHaveBeenCalledWith({
      subjectToken: 'realmroot-agent-token',
      audience: resource,
      scopes: ['workers-scripts.write'],
    })
    expect(upstream).toHaveBeenCalledTimes(1)
  })

  it('[spec: cloudflare-adapter/cloudflare-native-tool-discovery] forwards Wrangler custom-domain changesets with write authority', async () => {
    const upstream = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const request = input instanceof Request ? input : new Request(input, init)
      expect(request.url).toBe(
        'https://api.cloudflare.com/client/v4/accounts/account-1/workers/scripts/wallet/domains/changeset?replace_state=true',
      )
      expect(request.method).toBe('POST')
      await expect(request.json()).resolves.toEqual([{ hostname: 'wallet.example' }])
      return Response.json({ success: true, result: { updated: [] } })
    })
    const { app, exchange } = fixture({ upstream, principal: principal(['workers-scripts.write']) })

    const response = await app.request(
      '/cloudflare/accounts/account-1/workers/scripts/wallet/domains/changeset?replace_state=true',
      {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify([{ hostname: 'wallet.example' }]),
      },
    )

    expect(response.status).toBe(200)
    expect(exchange).toHaveBeenCalledWith({
      subjectToken: 'realmroot-agent-token',
      audience: resource,
      scopes: ['workers-scripts.write'],
    })
    expect(upstream).toHaveBeenCalledTimes(1)
  })

  it('fails closed before exchange for an unpublished operation or insufficient Agent scope', async () => {
    const unpublished = fixture()
    expect((await unpublished.app.request('/cloudflare/not-an-operation')).status).toBe(404)
    expect(unpublished.exchange).not.toHaveBeenCalled()

    const denied = fixture({ principal: principal(['dns.read']) })
    expect(
      (
        await denied.app.request('/cloudflare/zones/zone-1/dns_records', {
          method: 'POST',
        })
      ).status,
    ).toBe(403)
    expect(denied.exchange).not.toHaveBeenCalled()
  })
})

function fixture(options: { upstream?: typeof fetch; principal?: AgentPrincipal } = {}) {
  const audit = vi.fn(async (_record: Record<string, unknown>) => undefined)
  const exchange = vi.fn(async () => ({
    accessToken: 'provider-access',
    expiresIn: 300,
    scopes: options.principal?.scopes ?? new Set(['dns.write']),
  }))
  const adapter = createCloudflareAdapter(
    {
      origin: 'https://adapters.example',
      realmrootIssuer: 'https://id.example/api/auth',
      applicationClientId: 'adapter-client',
      applicationClientSecret: 'adapter-secret',
      cloudflareApiOrigin: 'https://api.cloudflare.com/client/v4',
    },
    {
      authenticator: { authenticate: vi.fn(async () => options.principal ?? principal(['dns.write'])) },
      exchange: { exchange },
      audit,
      fetch: options.upstream ?? vi.fn(async () => Response.json({ success: true })),
    },
  )
  return { app: createApp([adapter]), audit, exchange }
}

function principal(scopes: string[]): AgentPrincipal {
  return {
    subjectToken: 'realmroot-agent-token',
    subject: 'user-1',
    issuer: 'https://id.example/api/auth',
    actor: { issuer: 'https://id.example/api/auth', subject: 'agent-1', profile: 'ai_agent' },
    scopes: new Set(scopes),
    connectionId: 'connection-1',
    authorizationDetails: [],
  }
}
