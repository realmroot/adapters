import { decodeJwt } from 'jose'
import { describe, expect, it, vi } from 'vitest'
import { createRealmrootConnectionEventSink } from '../../src/core/connection-events.js'

describe('Realmroot Connection Event sink', () => {
  it('uses the Application client-credentials flow and sends a DPoP-bound idempotent event request', async () => {
    const request = vi.fn(async function (this: unknown, input: URL | RequestInfo) {
      expect(this).toBeUndefined()
      return String(input).endsWith('/oauth2/token')
        ? Response.json({
            access_token: 'realmroot-application-token',
            token_type: 'DPoP',
            expires_in: 300,
            scope: 'connection-events:write',
          })
        : new Response(null, { status: 204 })
    })
    const sink = connectionEventSink(request)

    await sink.send({
      id: 'delivery/1',
      type: 'authorityChanged',
      brokerReference: 'broker-1',
      occurredAt: '2027-01-15T08:00:00.000Z',
      revision: 7,
      scopes: ['metadata:read', 'issues:write'],
      affectedScopes: ['issues:write'],
      affectedAuthorizationDetails: [{ type: 'github_installation', installation_id: '42' }],
      authorityConstraints: [
        {
          authorizationDetails: [{ type: 'github_installation', installation_id: '42' }],
          scopes: ['issues:write'],
        },
      ],
    })

    const [tokenUrl, tokenInit] = request.mock.calls[0] as unknown as [string, RequestInit]
    expect(tokenUrl).toBe('https://id.example/api/auth/oauth2/token')
    expect(tokenInit.headers).toMatchObject({
      Authorization: `Basic ${btoa('realmroot-client:realmroot-secret')}`,
      'Content-Type': 'application/x-www-form-urlencoded',
      DPoP: expect.any(String),
    })
    expect(Object.fromEntries(new URLSearchParams(String(tokenInit.body)))).toEqual({
      grant_type: 'client_credentials',
      resource: 'https://id.example/api',
      scope: 'connection-events:write',
    })
    const tokenDpop = new Headers(tokenInit.headers).get('DPoP')
    expect(tokenDpop).toBeTruthy()
    expect(decodeJwt(tokenDpop ?? '')).toMatchObject({
      htm: 'POST',
      htu: tokenUrl,
      jti: expect.any(String),
    })

    const [url, init] = request.mock.calls[1] as unknown as [URL, RequestInit]
    const pathname = '/api/resource-servers/res_github/connection-events/delivery%2F1'
    expect(url.toString()).toBe(`https://id.example${pathname}`)
    expect(init).toMatchObject({ method: 'PUT' })
    expect(init.headers).toMatchObject({
      Authorization: 'DPoP realmroot-application-token',
      DPoP: expect.any(String),
    })
    const requestDpop = new Headers(init.headers).get('DPoP')
    expect(requestDpop).toBeTruthy()
    expect(decodeJwt(requestDpop ?? '')).toMatchObject({
      htm: 'PUT',
      htu: url.toString(),
      ath: expect.any(String),
      jti: expect.any(String),
    })
    expect(JSON.parse(String(init.body))).toEqual({
      type: 'authorityChanged',
      brokerReference: 'broker-1',
      occurredAt: '2027-01-15T08:00:00.000Z',
      revision: 7,
      scopes: ['metadata:read', 'issues:write'],
      affectedScopes: ['issues:write'],
      affectedAuthorizationDetails: [{ type: 'github_installation', installation_id: '42' }],
      authorityConstraints: [
        {
          authorizationDetails: [{ type: 'github_installation', installation_id: '42' }],
          scopes: ['issues:write'],
        },
      ],
    })
  })

  it('surfaces rejected credentials and rejected Connection Events so the provider can retry', async () => {
    const rejectedCredentials = connectionEventSink(async () => new Response(null, { status: 401 }))
    await expect(rejectedCredentials.send(revokedEvent())).rejects.toThrow('credentials with status 401')

    let calls = 0
    const rejectedEvent = connectionEventSink(async () => {
      calls += 1
      return calls === 1
        ? Response.json({
            access_token: 'token',
            token_type: 'DPoP',
            expires_in: 300,
            scope: 'connection-events:write',
          })
        : new Response(null, { status: 409 })
    })
    await expect(rejectedEvent.send(revokedEvent())).rejects.toThrow('Event with status 409')
  })

  it('bounds a stalled Realmroot OAuth request', async () => {
    const sink = connectionEventSink(
      async (_url, init) =>
        new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener('abort', () => reject(init.signal?.reason), { once: true })
        }),
      1,
    )
    await expect(sink.send(revokedEvent())).rejects.toThrow()
  })
})

function connectionEventSink(request: typeof fetch, timeoutMs?: number) {
  return createRealmrootConnectionEventSink({
    issuer: 'https://id.example/api/auth',
    resourceServerId: 'res_github',
    clientId: 'realmroot-client',
    clientSecret: 'realmroot-secret',
    fetch: request,
    ...(timeoutMs ? { timeoutMs } : {}),
  })
}

function revokedEvent() {
  return {
    id: 'delivery-2',
    type: 'revoked' as const,
    brokerReference: 'broker-1',
    occurredAt: new Date().toISOString(),
    revision: 8,
  }
}
