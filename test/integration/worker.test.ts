import { env, SELF } from 'cloudflare:test'
import { describe, expect, it, vi } from 'vitest'
import { D1RuntimeState } from '../../src/storage/d1-runtime-state.js'

describe('Cloudflare Worker runtime', () => {
  it('serves the adapter through the workerd entrypoint', async () => {
    const response = await SELF.fetch('https://adapter.example/health')
    expect(response.status).toBe(200)
    await expect(response.json()).resolves.toEqual({ status: 'ok' })
  })

  it('persists replay protection, idempotency, and audit state in real D1', async () => {
    const state = new D1RuntimeState(env.DB)
    const proof = { keyThumbprint: 'thumbprint', jti: 'proof-1', now: 1_000, expiresAt: 301_000 }
    await expect(state.claim(proof)).resolves.toBe(true)
    await expect(state.claim(proof)).resolves.toBe(false)

    const operation = vi.fn(async () => Response.json({ id: 1 }, { status: 201 }))
    const first = await state.execute('issue-1', 'agent:repository:create-issue', { title: 'One' }, operation)
    const replay = await state.execute('issue-1', 'agent:repository:create-issue', { title: 'One' }, operation)
    expect(first.status).toBe(201)
    expect(replay.status).toBe(201)
    expect(operation).toHaveBeenCalledOnce()

    await state.recordAudit({
      requestId: 'request-1',
      event: 'provider.operation',
      occurredAt: new Date().toISOString(),
    })
    const audit = await env.DB.prepare('SELECT event_json FROM adapter_audit_event WHERE request_id = ?')
      .bind('request-1')
      .first<{ event_json: string }>()
    expect(JSON.parse(audit?.event_json ?? '{}')).toMatchObject({ event: 'provider.operation' })
  })
})
