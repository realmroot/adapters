import { createHmac } from 'node:crypto'
import { describe, expect, it, vi } from 'vitest'
import { createRealmrootConnectionEventSink } from '../../src/core/connection-events.js'

describe('Realmroot Connection Event sink', () => {
  it('authenticates and body-binds an idempotent event request', async () => {
    const secret = 'a-provider-connection-secret-with-32-bytes'
    const request = vi.fn(async function (this: unknown) {
      expect(this).toBeUndefined()
      return new Response(null, { status: 204 })
    })
    const sink = createRealmrootConnectionEventSink({
      issuer: 'https://id.example/api/auth',
      resource: 'https://adapter.example/github',
      secret,
      fetch: request,
      now: () => 1_800_000_000_000,
    })

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

    const [url, init] = request.mock.calls[0] as unknown as [URL, RequestInit]
    const pathname = '/api/provider-connection-events/delivery%2F1'
    const body = String(init.body)
    const timestamp = '1800000000'
    const signature = createHmac('sha256', secret).update(`${timestamp}\nPUT\n${pathname}\n${body}`).digest('hex')
    expect(url.toString()).toBe(`https://id.example${pathname}`)
    expect(init).toMatchObject({ method: 'PUT', body })
    expect(init.headers).toMatchObject({
      Authorization: `Bearer ${secret}`,
      'Realmroot-Timestamp': timestamp,
      'Realmroot-Signature': `sha256=${signature}`,
    })
    expect(JSON.parse(body)).toEqual({
      type: 'authorityChanged',
      resource: 'https://adapter.example/github',
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

  it('surfaces a rejected Connection Event so the provider can retry', async () => {
    const sink = createRealmrootConnectionEventSink({
      issuer: 'https://id.example/api/auth',
      resource: 'https://adapter.example/github',
      secret: 'a-provider-connection-secret-with-32-bytes',
      fetch: async () => new Response(null, { status: 409 }),
    })

    await expect(
      sink.send({
        id: 'delivery-2',
        type: 'revoked',
        brokerReference: 'broker-1',
        occurredAt: new Date().toISOString(),
        revision: 8,
      }),
    ).rejects.toThrow('status 409')
  })

  it('bounds a stalled Realmroot backchannel request', async () => {
    const sink = createRealmrootConnectionEventSink({
      issuer: 'https://id.example/api/auth',
      resource: 'https://adapter.example/github',
      secret: 'a-provider-connection-secret-with-32-bytes',
      timeoutMs: 1,
      fetch: async (_url, init) =>
        new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener('abort', () => reject(init.signal?.reason), { once: true })
        }),
    })

    await expect(
      sink.send({
        id: 'delivery-timeout',
        type: 'suspended',
        brokerReference: 'broker-1',
        occurredAt: new Date().toISOString(),
        revision: 9,
      }),
    ).rejects.toThrow()
  })
})
