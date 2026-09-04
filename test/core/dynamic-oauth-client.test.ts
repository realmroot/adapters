import { describe, expect, it, vi } from 'vitest'
import { createDynamicOAuthClient, type DynamicOAuthRegistrationStore } from '../../src/core/dynamic-oauth-client.js'

describe('Dynamic OAuth client', () => {
  it('[spec: context7-adapter/context7-provider-oauth] registers a public client once and uses PKCE', async () => {
    let clientId: string | null = null
    const store: DynamicOAuthRegistrationStore = {
      clientId: vi.fn(async () => clientId),
      saveClientId: vi.fn(async (_providerId, value) => {
        clientId = value
        return value
      }),
    }
    const fetcher = vi.fn(async (request: string | URL | Request, init?: RequestInit) => {
      const url = new URL(request instanceof Request ? request.url : request)
      if (url.pathname === '/oauth/register') {
        expect(JSON.parse(String(init?.body))).toMatchObject({
          token_endpoint_auth_method: 'none',
          scope: 'openid offline_access',
        })
        return Response.json({ client_id: 'dynamic-client' }, { status: 201 })
      }
      if (url.pathname === '/oauth/token') {
        return Response.json({
          access_token: 'context7-access',
          refresh_token: 'context7-refresh',
          expires_in: 3600,
          scope: 'openid offline_access',
        })
      }
      throw new Error(`Unexpected request ${url}`)
    })
    const client = createDynamicOAuthClient({
      providerId: 'context7',
      clientName: 'Realmroot Context7 Adapter',
      issuer: 'https://clerk.context7.com',
      redirectUri: 'https://adapter.example/oauth/context7/provider/callback',
      scopes: ['openid', 'offline_access'],
      registrationStore: store,
      fetcher: fetcher as typeof fetch,
      now: () => 1_000,
    })

    const first = await client.authorizationUrl('provider-state')
    const second = await client.authorizationUrl('another-state')
    const url = new URL(first.url)
    expect(url.searchParams.get('client_id')).toBe('dynamic-client')
    expect(url.searchParams.get('code_challenge_method')).toBe('S256')
    expect(url.searchParams.get('code_challenge')).toHaveLength(43)
    expect(first.verifier).not.toBe(second.verifier)
    expect(
      fetcher.mock.calls.filter(([request]) => new URL(String(request)).pathname === '/oauth/register'),
    ).toHaveLength(1)

    await expect(client.exchangeCode('provider-code', first.verifier)).resolves.toMatchObject({
      accessToken: 'context7-access',
      refreshToken: 'context7-refresh',
      expiresAt: 3_601_000,
    })
    const tokenRequest = fetcher.mock.calls.find(([request]) => new URL(String(request)).pathname === '/oauth/token')
    const tokenInit = tokenRequest?.[1] as RequestInit
    expect(String(tokenInit.body)).toContain(`code_verifier=${first.verifier}`)
    expect(String(tokenInit.body)).toContain('client_id=dynamic-client')
  })
})
