import { describe, expect, it, vi } from 'vitest'
import { MemoryIdempotencyStore } from '../../src/core/idempotency.js'

describe('MemoryIdempotencyStore', () => {
  it('replays a completed result and rejects conflicting reuse', async () => {
    const store = new MemoryIdempotencyStore()
    const operation = vi.fn(async () => Response.json({ id: 1 }, { status: 201 }))

    const first = await store.execute('key-1', 'agent:operation', { title: 'one' }, operation)
    const replay = await store.execute('key-1', 'agent:operation', { title: 'one' }, operation)

    expect(first.status).toBe(201)
    expect(await replay.json()).toEqual({ id: 1 })
    expect(operation).toHaveBeenCalledOnce()
    await expect(store.execute('key-1', 'agent:operation', { title: 'two' }, operation)).rejects.toThrow(
      'reused with different input',
    )
  })
})
