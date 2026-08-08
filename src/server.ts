import { serve } from '@hono/node-server'
import { createApp } from './app.js'
import { loadConfig } from './config.js'

const config = await loadConfig()
const app = createApp(config)

serve({ fetch: app.fetch, hostname: '127.0.0.1', port: config.port }, (info) => {
  console.log(`Realmroot adapters listening at ${config.origin} (${info.address}:${info.port})`)
  console.log(`Realmroot issuer: ${config.realmrootIssuer}`)
})
