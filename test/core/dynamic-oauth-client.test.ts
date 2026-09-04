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
      endpoints: {
        authorization: 'https://clerk.context7.com/oauth/authorize',
        registration: 'https://clerk.context7.com/oauth/register',
        token: 'https://clerk.context7.com/oauth/token',
        userInfo: 'https://clerk.context7.com/oauth/userinfo',
        revocation: 'https://clerk.context7.com/oauth/token/revoke',
      },
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

  it('[spec: todoist-adapter/todoist-provider-oauth] supports split endpoints and comma-separated authorization scopes', async () => {
    const store: DynamicOAuthRegistrationStore = {
      clientId: vi.fn(async () => null),
      saveClientId: vi.fn(async (_providerId, value) => value),
    }
    const fetcher = vi.fn(async (request: string | URL | Request) => {
      const url = new URL(request instanceof Request ? request.url : request)
      if (url.pathname === '/oauth/register') return Response.json({ client_id: 'tdd_dynamic' }, { status: 201 })
      if (url.pathname === '/oauth/access_token') {
        return Response.json({
          access_token: 'todoist-access',
          refresh_token: 'todoist-refresh',
          expires_in: 3600,
          scope: 'data:read,user:read',
        })
      }
      if (url.pathname === '/api/v1/user') return Response.json({ id: 'user-1' })
      throw new Error(`Unexpected request ${url}`)
    })
    const client = createDynamicOAuthClient({
      providerId: 'todoist',
      clientName: 'Realmroot Todoist Adapter',
      endpoints: {
        authorization: 'https://app.todoist.com/oauth/authorize',
        registration: 'https://api.todoist.com/oauth/register',
        token: 'https://api.todoist.com/oauth/access_token',
        userInfo: 'https://api.todoist.com/api/v1/user',
      },
      redirectUri: 'https://adapter.example/oauth/todoist/provider/callback',
      scopes: ['data:read', 'user:read'],
      authorizationScopeSeparator: ',',
      authorizationWrapper: {
        endpoint: 'https://app.todoist.com/users/showlogin',
        returnUrlParameter: 'success_page',
      },
      registrationStore: store,
      fetcher: fetcher as typeof fetch,
      now: () => 1_000,
    })

    const started = await client.authorizationUrl('todoist-state')
    const authorizationUrl = new URL(started.url)
    expect(authorizationUrl.pathname).toBe('/users/showlogin')
    const providerUrl = new URL(authorizationUrl.searchParams.get('success_page') ?? '')
    expect(providerUrl.pathname).toBe('/oauth/authorize')
    expect(providerUrl.searchParams.get('scope')).toBe('data:read,user:read')
    expect(providerUrl.searchParams.get('code_challenge')).toHaveLength(43)
    expect(providerUrl.searchParams.get('code_challenge_method')).toBe('S256')
    expect(client.revoke).toBeUndefined()
    await expect(client.exchangeCode('todoist-code', started.verifier)).resolves.toMatchObject({
      accessToken: 'todoist-access',
      refreshToken: 'todoist-refresh',
      scopes: ['data:read', 'user:read'],
    })
  })
})
