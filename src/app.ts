import { Hono } from 'hono'
import { z } from 'zod'
import type { AdapterEnv, AdapterModule } from './core/adapter.js'
import { badRequest, HttpProblem } from './core/problem.js'

export function createApp(adapters: readonly AdapterModule[]) {
  const app = new Hono<AdapterEnv>()

  app.use('*', async (c, next) => {
    const startedAt = Date.now()
    c.set('requestId', crypto.randomUUID())
    try {
      await next()
    } finally {
      c.header('Request-Id', c.get('requestId'))
      const failure = c.get('failure')
      const record = JSON.stringify({
        event: 'request.complete',
        requestId: c.get('requestId'),
        method: c.req.method,
        path: new URL(c.req.url).pathname,
        status: c.res.status,
        durationMs: Date.now() - startedAt,
        ...(failure ? { failure } : {}),
      })
      if (c.res.status >= 500) console.error(record)
      else console.info(record)
    }
  })

  app.get('/health', (c) => c.json({ status: 'ok' }))
  for (const adapter of adapters) adapter.register(app)

  app.notFound((c) =>
    problemResponse(
      new HttpProblem(404, 'about:blank', 'Not Found', 'The resource was not found.'),
      c.req.url,
      c.get('requestId'),
    ),
  )
  app.onError((error, c) => {
    const problem = normalizeProblem(error)
    c.set('failure', {
      type: problem.type,
      ...(problem.status >= 500 ? { error: serializedError(error) } : {}),
    })
    return problemResponse(problem, c.req.url, c.get('requestId'))
  })
  return app
}

function normalizeProblem(error: unknown) {
  if (error instanceof HttpProblem) return error
  if (error instanceof z.ZodError) return badRequest(z.prettifyError(error))
  return new HttpProblem(500, 'about:blank', 'Internal Server Error', 'The adapter could not complete the request.')
}

function serializedError(error: unknown) {
  if (error instanceof Error) {
    return { name: error.name, message: error.message, ...(error.stack ? { stack: error.stack } : {}) }
  }
  return { name: 'UnknownError', message: String(error) }
}

function problemResponse(problem: HttpProblem, instance: string, requestId: string) {
  return new Response(
    JSON.stringify({
      type: problem.type,
      title: problem.title,
      status: problem.status,
      detail: problem.message,
      instance,
    }),
    {
      status: problem.status,
      headers: {
        'Content-Type': 'application/problem+json',
        'Request-Id': requestId,
        ...problem.headers,
      },
    },
  )
}
