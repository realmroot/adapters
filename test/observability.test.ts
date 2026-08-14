import { afterEach, expect, it, vi } from 'vitest'
import { createApp } from '../src/app.js'

afterEach(() => vi.restoreAllMocks())

it('emits one correlated request completion event without trusting caller request identity', async () => {
  const info = vi.spyOn(console, 'info').mockImplementation(() => {})
  const response = await createApp([]).request('/health', {
    headers: { 'x-correlation-id': '0123456789abcdef0123456789abcdef' },
  })

  expect(response.status).toBe(200)
  expect(response.headers.get('request-id')).toBeTruthy()
  expect(info).toHaveBeenCalledOnce()
  const [entry] = info.mock.calls
  expect(JSON.parse(entry?.[0] ?? '{}')).toMatchObject({
    event: 'request.complete',
    correlationId: '0123456789abcdef0123456789abcdef',
    method: 'GET',
    path: '/health',
    status: 200,
  })
})
