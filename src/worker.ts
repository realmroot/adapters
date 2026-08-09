import { createApp } from './app.js'
import { loadConfig } from './config.js'
import { createBrokerRequestVerifiers } from './core/connection-request.js'
import { createRealmrootAuthenticator } from './core/realmroot-auth.js'
import { createGitHubAdapter } from './providers/github/adapter.js'
import { loadGitHubConfig } from './providers/github/config.js'
import { D1GitHubConnections } from './providers/github/connections.js'
import { createLinearAdapter } from './providers/linear/adapter.js'
import { loadLinearConfig } from './providers/linear/config.js'
import { D1LinearConnections } from './providers/linear/connections.js'
import { createLinearCredentialCipher } from './providers/linear/credentials.js'
import { D1RuntimeState } from './storage/d1-runtime-state.js'

export default {
  fetch(request, env, executionContext) {
    const config = loadConfig(env, request.url)
    const githubConfig = loadGitHubConfig(env, config)
    const linearConfig = loadLinearConfig(env, config)
    const state = new D1RuntimeState(env.DB)
    const authenticator = createRealmrootAuthenticator({
      issuer: config.realmrootIssuer,
      jwksUrl: config.realmrootJwksUrl,
      replayStore: state,
    })
    const githubBrokerRequests = createBrokerRequestVerifiers(config, `${config.origin}/github`)
    const linearBrokerRequests = createBrokerRequestVerifiers(config, `${config.origin}/linear`)
    const linearConnections = linearConfig.linearCredentialEncryptionKey
      ? new D1LinearConnections(env.DB, createLinearCredentialCipher(linearConfig.linearCredentialEncryptionKey))
      : undefined
    const app = createApp([
      createGitHubAdapter(githubConfig, {
        authenticator,
        audit: (record) => state.recordAudit(record),
        connectionRequestVerifier: githubBrokerRequests.verifyConnection,
        revocationRequestVerifier: githubBrokerRequests.verifyRevocation,
        connections: new D1GitHubConnections(env.DB),
      }),
      createLinearAdapter(linearConfig, {
        authenticator,
        audit: (record) => state.recordAudit(record),
        connectionRequestVerifier: linearBrokerRequests.verifyConnection,
        revocationRequestVerifier: linearBrokerRequests.verifyRevocation,
        ...(linearConnections ? { connections: linearConnections } : {}),
      }),
    ])
    return app.fetch(request, env, executionContext)
  },
} satisfies ExportedHandler<Env>
