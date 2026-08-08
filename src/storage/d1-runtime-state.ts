import { z } from 'zod'
import { sha256Hex } from '../core/digest.js'
import type { DpopReplayStore } from '../core/realmroot-auth.js'

export class D1RuntimeState implements DpopReplayStore {
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

  async recordAudit(record: Record<string, unknown>) {
    const requestId = z.string().parse(record.requestId)
    const occurredAt = z.iso.datetime().parse(record.occurredAt)
    await this.db
      .prepare('INSERT INTO adapter_audit_event (request_id, event_json, occurred_at) VALUES (?, ?, ?)')
      .bind(requestId, JSON.stringify(record), occurredAt)
      .run()
  }
}
