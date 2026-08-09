import { describe, expect, it, vi } from 'vitest'
import { createLinearProvider } from '../../src/providers/linear/client.js'

describe('Linear provider client', () => {
  it('builds distinct user and App actor authorization URLs', () => {
    const provider = createProvider(vi.fn())
    const user = new URL(provider.authorizationUrl({ actor: 'user', state: 'user-state', scopes: ['read'] }))
    const app = new URL(
      provider.authorizationUrl({ actor: 'app', state: 'app-state', scopes: ['read', 'app:mentionable'] }),
    )
    expect(user.searchParams.get('actor')).toBeNull()
    expect(user.searchParams.get('scope')).toBe('read')
    expect(app.searchParams.get('actor')).toBe('app')
    expect(app.searchParams.get('scope')).toBe('read,app:mentionable')
    expect(app.searchParams.get('prompt')).toBe('consent')
  })

  it('exchanges, refreshes, and revokes rotating OAuth credentials', async () => {
    const fetcher = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(
        Response.json({
          access_token: 'access-1',
          refresh_token: 'refresh-1',
          expires_in: 3600,
          scope: 'read write',
        }),
      )
      .mockResolvedValueOnce(
        Response.json({
          access_token: 'access-2',
          refresh_token: 'refresh-2',
          expires_in: 3600,
          scope: ['read', 'write'],
        }),
      )
      .mockResolvedValueOnce(new Response(null, { status: 200 }))
    const provider = createProvider(fetcher)
    await expect(provider.exchangeCode('code')).resolves.toMatchObject({
      accessToken: 'access-1',
      scopes: ['read', 'write'],
    })
    await expect(provider.refresh('refresh-1')).resolves.toMatchObject({ refreshToken: 'refresh-2' })
    await provider.revoke('refresh-2')
    const refreshBody = fetcher.mock.calls[1]?.[1]?.body as URLSearchParams
    expect(refreshBody.get('grant_type')).toBe('refresh_token')
    expect(refreshBody.get('refresh_token')).toBe('refresh-1')
    expect(String(fetcher.mock.calls[2]?.[0])).toBe('https://api.linear.app/oauth/revoke')
  })

  it('reads the current actor and forwards GraphQL without Realmroot credentials', async () => {
    const fetcher = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(
        Response.json({
          data: {
            viewer: { id: 'app-user-1', name: 'Realmroot', email: null },
            organization: { id: 'workspace-1', name: 'Realmroot', urlKey: 'realmroot', logoUrl: null },
          },
        }),
      )
      .mockResolvedValueOnce(Response.json({ data: { viewer: { id: 'app-user-1' } } }))
    const provider = createProvider(fetcher)
    await expect(provider.viewer('provider-access')).resolves.toMatchObject({
      user: { id: 'app-user-1' },
      workspace: { id: 'workspace-1' },
    })
    await provider.request(
      new Request('https://api.linear.app/graphql', {
        method: 'POST',
        headers: { authorization: 'DPoP realmroot-token', dpop: 'proof', 'content-type': 'application/json' },
        body: '{}',
      }),
      'provider-access',
    )
    const forwarded = fetcher.mock.calls[1]?.[0] as Request
    expect(forwarded.headers.get('authorization')).toBe('Bearer provider-access')
    expect(forwarded.headers.get('dpop')).toBeNull()
  })
})

function createProvider(fetcher: typeof fetch) {
  return createLinearProvider({
    clientId: 'linear-client',
    clientSecret: 'linear-secret',
    redirectUri: 'https://adapter.example/linear/oauth/callback',
    apiOrigin: 'https://api.linear.app',
    authorizationOrigin: 'https://linear.app',
    fetcher,
    now: () => 1_000,
  })
}
