import { describe, expect, it, vi } from 'vitest'
import { createRealmrootTokenExchangeClient } from '../../src/core/oauth-client.js'

describe('Realmroot token-exchange client', () => {
  it('discovers the standard endpoint, authenticates the Application, and returns only the provider access token', async () => {
    const request = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const url = String(input)
      if (url.endsWith('/.well-known/openid-configuration')) {
        return Response.json({ token_endpoint: 'https://id.example/api/auth/oauth2/token' })
      }
      expect(url).toBe('https://id.example/api/auth/oauth2/token')
      expect(new Headers(init?.headers).get('authorization')).toBe(`Basic ${btoa('adapter:secret')}`)
      const form = new URLSearchParams(String(init?.body))
      expect(Object.fromEntries(form)).toEqual({
        grant_type: 'urn:ietf:params:oauth:grant-type:token-exchange',
        subject_token: 'agent-token',
        subject_token_type: 'urn:ietf:params:oauth:token-type:access_token',
        requested_token_type: 'urn:ietf:params:oauth:token-type:access_token',
        audience: 'https://adapters.example/cloudflare',
        scope: 'dns.read',
      })
      return Response.json({
        access_token: 'provider-token',
        token_type: 'Bearer',
        issued_token_type: 'urn:ietf:params:oauth:token-type:access_token',
        expires_in: 300,
        scope: 'dns.read zone.read',
      })
    })
    const client = createRealmrootTokenExchangeClient({
      issuer: 'https://id.example/api/auth',
      clientId: 'adapter',
      clientSecret: 'secret',
      fetch: request as typeof fetch,
    })
    await expect(
      client.exchange({
        subjectToken: 'agent-token',
        audience: 'https://adapters.example/cloudflare',
        scopes: ['dns.read'],
      }),
    ).resolves.toEqual({ accessToken: 'provider-token', expiresIn: 300, scopes: new Set(['dns.read', 'zone.read']) })
  })

  it('does not include Realmroot OAuth error content in the surfaced failure', async () => {
    const request = vi
      .fn()
      .mockResolvedValueOnce(Response.json({ token_endpoint: 'https://id.example/token' }))
      .mockResolvedValueOnce(
        Response.json({ error: 'invalid_grant', error_description: 'provider-token-secret' }, { status: 400 }),
      )
    const client = createRealmrootTokenExchangeClient({
      issuer: 'https://id.example',
      clientId: 'adapter',
      clientSecret: 'secret',
      fetch: request,
    })
    await expect(
      client.exchange({ subjectToken: 'agent-token', audience: 'https://adapter.example', scopes: ['read'] }),
    ).rejects.not.toThrow('provider-token-secret')
  })
})
