import { z } from 'zod'
import { sha256Hex } from '../core/digest.js'
import type { IdempotencyStore } from '../core/idempotency.js'
import { badRequest, conflict } from '../core/problem.js'
import type { DpopReplayStore } from '../core/realmroot-auth.js'

const storedResponseSchema = z.object({
  fingerprint: z.string(),
  state: z.enum(['pending', 'completed']),
  status: z.number().int().nullable(),
  headersJson: z.string().nullable(),
  body: z.string().nullable(),
})
const storedHeadersSchema = z.array(z.tuple([z.string(), z.string()]))
const idempotencyTtlMs = 24 * 60 * 60 * 1000

export class D1RuntimeState implements DpopReplayStore, IdempotencyStore {
  constructor(private readonly db: D1Database) {}

  async claim(input: { keyThumbprint: string; jti: string; expiresAt: number; now: number }) {
    const proofHash = await sha256Hex(`${input.keyThumbprint}:${input.jti}`)
    await this.db.prepare('DELETE FROM dpop_replay WHERE expires_at <= ?').bind(input.now).run()
    const result = await this.db
      .prepare(
        'INSERT INTO dpop_replay (proof_hash, key_thumbprint, expires_at, created_at) VALUES (?, ?, ?, ?) ON CONFLICT DO NOTHING',
      )
      .bind(proofHash, input.keyThumbprint, input.expiresAt, input.now)
      .run()
    return result.meta.changes === 1
  }

  async execute(key: string | null, namespace: string, input: unknown, operation: () => Promise<Response>) {
    if (!key || key.length > 200) throw badRequest('A valid Idempotency-Key header is required.')
    const now = Date.now()
    const fingerprint = await sha256Hex(JSON.stringify(input))
    await this.db.prepare('DELETE FROM idempotency_response WHERE expires_at <= ?').bind(now).run()
    const reservation = await this.db
      .prepare(
        `INSERT INTO idempotency_response
          (namespace, idempotency_key, fingerprint, state, expires_at, created_at, updated_at)
         VALUES (?, ?, ?, 'pending', ?, ?, ?)
         ON CONFLICT DO NOTHING`,
      )
      .bind(namespace, key, fingerprint, now + idempotencyTtlMs, now, now)
      .run()

    if (reservation.meta.changes === 0) return this.replay(namespace, key, fingerprint)

    const response = await operation()
    const body = await response.text()
    if (!response.ok) {
      await this.db
        .prepare("DELETE FROM idempotency_response WHERE namespace = ? AND idempotency_key = ? AND state = 'pending'")
        .bind(namespace, key)
        .run()
      return new Response(body, { status: response.status, headers: response.headers })
    }

    await this.db
      .prepare(
        `UPDATE idempotency_response
         SET state = 'completed', status = ?, headers_json = ?, body = ?, updated_at = ?
         WHERE namespace = ? AND idempotency_key = ? AND fingerprint = ? AND state = 'pending'`,
      )
      .bind(
        response.status,
        JSON.stringify([...response.headers.entries()]),
        body,
        Date.now(),
        namespace,
        key,
        fingerprint,
      )
      .run()
    return new Response(body, { status: response.status, headers: response.headers })
  }

  async recordAudit(record: Record<string, unknown>) {
    const requestId = z.string().parse(record.requestId)
    const occurredAt = z.iso.datetime().parse(record.occurredAt)
    await this.db
      .prepare('INSERT INTO adapter_audit_event (request_id, event_json, occurred_at) VALUES (?, ?, ?)')
      .bind(requestId, JSON.stringify(record), occurredAt)
      .run()
  }

  private async replay(namespace: string, key: string, fingerprint: string) {
    const row = await this.db
      .prepare(
        `SELECT fingerprint, state, status, headers_json AS headersJson, body
         FROM idempotency_response WHERE namespace = ? AND idempotency_key = ?`,
      )
      .bind(namespace, key)
      .first()
    const stored = storedResponseSchema.parse(row)
    if (stored.fingerprint !== fingerprint) throw conflict('The idempotency key was reused with different input.')
    if (stored.state === 'pending')
      throw conflict('The idempotent operation is still pending or its outcome is unknown.')
    const status = z.number().int().parse(stored.status)
    const body = z.string().parse(stored.body)
    const headers = storedHeadersSchema.parse(JSON.parse(z.string().parse(stored.headersJson)))
    return new Response(body, { status, headers })
  }
}
