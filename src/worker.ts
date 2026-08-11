import { createApp } from './app.js'
import { loadConfig } from './config.js'
import { createRealmrootConnectionEventSink } from './core/connection-events.js'
import { createBrokerRequestVerifiers } from './core/connection-request.js'
import { createRealmrootTokenExchangeClient } from './core/oauth-client.js'
import { createRealmrootAuthenticator } from './core/realmroot-auth.js'
import { createCloudflareAdapter } from './providers/cloudflare/adapter.js'
import { loadCloudflareConfig } from './providers/cloudflare/config.js'
import { createGitHubAdapter } from './providers/github/adapter.js'
import { loadGitHubConfig } from './providers/github/config.js'
import { D1GitHubConnections } from './providers/github/connections.js'
import { deliverPendingGitHubConnectionEvents } from './providers/github/webhooks.js'
import { createLinearAdapter } from './providers/linear/adapter.js'
import { loadLinearConfig } from './providers/linear/config.js'
import { D1LinearConnections } from './providers/linear/connections.js'
import { createLinearCredentialCipher } from './providers/linear/credentials.js'
import { D1RuntimeState } from './storage/d1-runtime-state.js'

export default {
  async fetch(request, env, executionContext) {
    const config = loadConfig(env, request.url)
    const githubConfig = loadGitHubConfig(env, config)
    const cloudflareConfig = loadCloudflareConfig(env, config)
    const linearConfig = loadLinearConfig(env, config)
    const state = new D1RuntimeState(env.DB)
    const githubConnections = new D1GitHubConnections(env.DB, state)
    const authenticator = createRealmrootAuthenticator({
      issuer: config.realmrootIssuer,
      jwksUrl: config.realmrootJwksUrl,
      replayStore: state,
    })
    const githubBrokerRequests = createBrokerRequestVerifiers(config, `${config.origin}/github`)
    const linearBrokerRequests = createBrokerRequestVerifiers(config, `${config.origin}/linear`)
    const linearConnections = linearConfig.linearCredentialEncryptionKey
      ? new D1LinearConnections(env.DB, createLinearCredentialCipher(linearConfig.linearCredentialEncryptionKey), state)
      : undefined
    const connectionEvents =
      githubConfig.realmrootApplicationClientId &&
      githubConfig.realmrootApplicationClientSecret &&
      githubConfig.realmrootGitHubResourceServerId
        ? createRealmrootConnectionEventSink({
            issuer: config.realmrootIssuer,
            resourceServerId: githubConfig.realmrootGitHubResourceServerId,
            clientId: githubConfig.realmrootApplicationClientId,
            clientSecret: githubConfig.realmrootApplicationClientSecret,
            fetch,
          })
        : undefined
    const githubConnectionEventBarrier = async () => {
      if ((await githubConnections.pendingLifecycleEvents()).length === 0) return
      if (!connectionEvents) throw new Error('Pending GitHub Connection Events require backchannel configuration.')
      await deliverPendingGitHubConnectionEvents({ connections: githubConnections, events: connectionEvents })
    }
    const adapters = [
      createGitHubAdapter(githubConfig, {
        authenticator,
        audit: (record) => state.recordAudit(record),
        connectionRequestVerifier: githubBrokerRequests.verifyConnection,
        revocationRequestVerifier: githubBrokerRequests.verifyRevocation,
        connections: githubConnections,
        ...(connectionEvents ? { connectionEvents } : {}),
        connectionEventBarrier: githubConnectionEventBarrier,
      }),
      createLinearAdapter(linearConfig, {
        authenticator,
        audit: (record) => state.recordAudit(record),
        connectionRequestVerifier: linearBrokerRequests.verifyConnection,
        revocationRequestVerifier: linearBrokerRequests.verifyRevocation,
        ...(linearConnections ? { connections: linearConnections } : {}),
      }),
    ]
    if (cloudflareConfig) {
      adapters.push(
        createCloudflareAdapter(cloudflareConfig, {
          authenticator,
          exchange: createRealmrootTokenExchangeClient({
            issuer: config.realmrootIssuer,
            clientId: cloudflareConfig.applicationClientId,
            clientSecret: cloudflareConfig.applicationClientSecret,
            fetch,
          }),
          audit: (record) => state.recordAudit(record),
          fetch,
        }),
      )
    }
    const app = createApp(adapters)
    return app.fetch(request, env, executionContext)
  },
} satisfies ExportedHandler<Env>
