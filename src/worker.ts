import { createApp } from './app.js'
import { loadConfig } from './config.js'
import { createBrokerRequestVerifiers } from './core/connection-request.js'
import { createRealmrootAuthenticator } from './core/realmroot-auth.js'
import { D1GitHubConnections } from './storage/d1-github-connections.js'
import { D1RuntimeState } from './storage/d1-runtime-state.js'

export default {
  fetch(request, env, executionContext) {
    const config = loadConfig(env, request.url)
    const state = new D1RuntimeState(env.DB)
    const brokerRequests = createBrokerRequestVerifiers(config)
    const app = createApp(config, {
      authenticator: createRealmrootAuthenticator({
        issuer: config.realmrootIssuer,
        jwksUrl: config.realmrootJwksUrl,
        replayStore: state,
      }),
      idempotency: state,
      audit: (record) => state.recordAudit(record),
      connectionRequestVerifier: brokerRequests.verifyConnection,
      revocationRequestVerifier: brokerRequests.verifyRevocation,
      githubConnections: new D1GitHubConnections(env.DB),
    })
    return app.fetch(request, env, executionContext)
  },
} satisfies ExportedHandler<Env>
