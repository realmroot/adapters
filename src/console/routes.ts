import { Hono } from 'hono'
import { providerDirectory } from '../providers/registry.js'

export const consoleRoutes = new Hono<{ Bindings: Env }>().get('/api/providers', (c) => {
  c.header('Cache-Control', 'no-store')
  return c.json({
    items: providerDirectory(c.env),
  })
})

export type ConsoleApp = typeof consoleRoutes
