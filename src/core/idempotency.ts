import { createHash } from 'node:crypto'
import { badRequest, conflict } from './problem.js'

type StoredResponse = { fingerprint: string; status: number; headers: [string, string][]; body: string }

export class MemoryIdempotencyStore {
  readonly #responses = new Map<string, StoredResponse>()

  async execute(key: string | null, namespace: string, input: unknown, operation: () => Promise<Response>) {
    if (!key || key.length > 200) throw badRequest('A valid Idempotency-Key header is required.')
    const storageKey = `${namespace}:${key}`
    const fingerprint = createHash('sha256').update(JSON.stringify(input)).digest('hex')
    const stored = this.#responses.get(storageKey)
    if (stored) {
      if (stored.fingerprint !== fingerprint) throw conflict('The idempotency key was reused with different input.')
      return new Response(stored.body, { status: stored.status, headers: stored.headers })
    }
    const response = await operation()
    const body = await response.text()
    if (response.ok) {
      this.#responses.set(storageKey, {
        fingerprint,
        status: response.status,
        headers: [...response.headers.entries()],
        body,
      })
    }
    return new Response(body, { status: response.status, headers: response.headers })
  }
}
