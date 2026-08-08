import { createApp } from './app.js'
import { loadConfig } from './config.js'
import { createBrokerRequestVerifiers } from './core/connection-request.js'
import { createRealmrootAuthenticator } from './core/realmroot-auth.js'
import { createGitHubAdapter } from './providers/github/adapter.js'
import { loadGitHubConfig } from './providers/github/config.js'
import { D1GitHubConnections } from './providers/github/connections.js'
import { D1RuntimeState } from './storage/d1-runtime-state.js'

export default {
  fetch(request, env, executionContext) {
    const config = loadConfig(env, request.url)
    const githubConfig = loadGitHubConfig(env, config)
    const state = new D1RuntimeState(env.DB)
    const brokerRequests = createBrokerRequestVerifiers(config, `${config.origin}/github`)
    const authenticator = createRealmrootAuthenticator({
      issuer: config.realmrootIssuer,
      jwksUrl: config.realmrootJwksUrl,
      replayStore: state,
    })
    const app = createApp([
      createGitHubAdapter(githubConfig, {
        authenticator,
        audit: (record) => state.recordAudit(record),
        connectionRequestVerifier: brokerRequests.verifyConnection,
        revocationRequestVerifier: brokerRequests.verifyRevocation,
        connections: new D1GitHubConnections(env.DB),
      }),
    ])
    return app.fetch(request, env, executionContext)
  },
} satisfies ExportedHandler<Env>
