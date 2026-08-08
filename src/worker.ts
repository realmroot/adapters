import { createApp } from './app.js'
import { loadConfig } from './config.js'
import { createRealmrootAuthenticator } from './core/realmroot-auth.js'
import { D1RuntimeState } from './storage/d1-runtime-state.js'

export default {
  fetch(request, env, executionContext) {
    const config = loadConfig(env, request.url)
    const state = new D1RuntimeState(env.DB)
    const app = createApp(config, {
      authenticator: createRealmrootAuthenticator({
        issuer: config.realmrootIssuer,
        jwksUrl: config.realmrootJwksUrl,
        replayStore: state,
      }),
      idempotency: state,
      audit: (record) => state.recordAudit(record),
    })
    return app.fetch(request, env, executionContext)
  },
} satisfies ExportedHandler<Env>
