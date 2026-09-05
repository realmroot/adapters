import { createExecutionContext, env } from 'cloudflare:test'
import { expect, it } from 'vitest'
import { providerRegistry } from '../../src/providers/registry.js'
import worker from '../../src/worker.js'

it('serves the public registry without provider credentials, login, or upstream requests', async () => {
  const response = await worker.fetch(
    new Request('https://adapters.example/console/api/providers'),
    env,
    createExecutionContext(),
  )
  expect(response.status).toBe(200)
  const body = (await response.json()) as { items: Array<{ id: string; enabled: boolean }> }
  expect(body.items.map(({ id }) => id)).toEqual(providerRegistry.map(({ id }) => id))
  expect(body.items.every(({ enabled }) => !enabled)).toBe(true)
  expect(response.headers.get('set-cookie')).toBeNull()
})
