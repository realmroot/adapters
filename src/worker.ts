import { tracing } from 'cloudflare:workers'
import { createApp } from './app.js'
import { loadConfig } from './config.js'
import type { AdapterModule } from './core/adapter.js'
import { createConfiguredManagedProvider } from './core/configured-managed-provider.js'
import { createCredentialCipher } from './core/credential-cipher.js'
import { createExternalAuthorizationServer } from './core/external-authorization-server.js'
import { D1ExternalOAuthStore } from './core/external-oauth-store.js'
import { createCloudflareAdapter } from './providers/cloudflare/adapter.js'
import { loadCloudflareConfig } from './providers/cloudflare/config.js'
import { cloudflareManifest } from './providers/cloudflare/manifest.js'
import {
  createCloudflareExternalAuthorization,
  createCloudflareOAuthProvider,
  D1CloudflareCredentials,
} from './providers/cloudflare/oauth.js'
import { context7Definition } from './providers/context7/definition.js'
import { fastioDefinition } from './providers/fastio/definition.js'
import { createGitHubAdapter } from './providers/github/adapter.js'
import { createGitHubConnectionProvider, createGitHubProvider } from './providers/github/client.js'
import { loadGitHubConfig } from './providers/github/config.js'
import { D1GitHubConnections } from './providers/github/connections.js'
import { createGitHubExternalAuthorization } from './providers/github/external-authorization.js'
import { permissionsToScopes } from './providers/github/permissions.js'
import { createLinearAdapter } from './providers/linear/adapter.js'
import { createLinearProvider } from './providers/linear/client.js'
import { loadLinearConfig } from './providers/linear/config.js'
import { D1LinearConnections } from './providers/linear/connections.js'
import { createLinearCredentialCipher } from './providers/linear/credentials.js'
import { createLinearExternalAuthorization } from './providers/linear/external-authorization.js'
import { linearScopes } from './providers/linear/scopes.js'
import { search1ApiDefinition } from './providers/search1api/definition.js'
import { todoistDefinition } from './providers/todoist/definition.js'
import { D1RuntimeState } from './storage/d1-runtime-state.js'

export default {
  async fetch(request, env, executionContext) {
    return tracing.enterSpan('adapter.request.prepare', async (span) => {
      span.setAttribute('url.path', new URL(request.url).pathname)
      const config = loadConfig(env, request.url)
      const githubConfig = loadGitHubConfig(env, config)
      const cloudflareConfig = loadCloudflareConfig(env, config)
      const linearConfig = loadLinearConfig(env, config)
      const state = new D1RuntimeState(env.DB)
      const oauthStore = new D1ExternalOAuthStore(env.DB)
      const signingPrivateJwk = config.oauthSigningPrivateJwk ? JSON.parse(config.oauthSigningPrivateJwk) : undefined
      const adapters: AdapterModule[] = []

      if (
        githubConfig.githubAppId &&
        githubConfig.githubPrivateKey &&
        githubConfig.githubClientId &&
        githubConfig.githubClientSecret &&
        signingPrivateJwk
      ) {
        const githubConnections = new D1GitHubConnections(env.DB, state)
        const githubProvider = createGitHubProvider({
          appId: githubConfig.githubAppId,
          privateKey: githubConfig.githubPrivateKey,
          apiOrigin: githubConfig.githubApiOrigin,
          cache: caches.default,
          waitUntil: (promise) => executionContext.waitUntil(promise),
        })
        const githubExternal = createGitHubExternalAuthorization({
          origin: config.origin,
          connection: createGitHubConnectionProvider({
            appId: githubConfig.githubAppId,
            privateKey: githubConfig.githubPrivateKey,
            clientId: githubConfig.githubClientId,
            clientSecret: githubConfig.githubClientSecret,
            redirectUri: `${config.origin}/github/oauth/callback`,
            apiOrigin: githubConfig.githubApiOrigin,
          }),
          connections: githubConnections,
          oauthStore,
          scopes: permissionsToScopes(await githubProvider.appPermissions()),
        })
        const githubAuthorization = await createExternalAuthorizationServer({
          origin: config.origin,
          provider: githubExternal.authorization,
          providerCallbackPath: '/github/oauth/callback',
          store: oauthStore,
          signingPrivateJwk,
          replayStore: state,
        })
        adapters.push(
          githubAuthorization,
          githubExternal.installationCallback,
          createGitHubAdapter(githubConfig, {
            authenticator: githubAuthorization.authenticator,
            provider: githubProvider,
            audit: (record) => state.recordAudit(record),
            connections: githubConnections,
          }),
        )
      }

      if (
        linearConfig.linearClientId &&
        linearConfig.linearClientSecret &&
        linearConfig.linearCredentialEncryptionKey &&
        signingPrivateJwk
      ) {
        const linearConnections = new D1LinearConnections(
          env.DB,
          createLinearCredentialCipher(linearConfig.linearCredentialEncryptionKey),
          state,
        )
        const linearProvider = createLinearProvider({
          clientId: linearConfig.linearClientId,
          clientSecret: linearConfig.linearClientSecret,
          redirectUri: `${config.origin}/linear/oauth/callback`,
          apiOrigin: linearConfig.linearApiOrigin,
          authorizationOrigin: linearConfig.linearAuthorizationOrigin,
        })
        const linearAuthorization = await createExternalAuthorizationServer({
          origin: config.origin,
          provider: createLinearExternalAuthorization({
            origin: config.origin,
            provider: linearProvider,
            connections: linearConnections,
            scopes: linearScopes,
          }),
          providerCallbackPath: '/linear/oauth/callback',
          store: oauthStore,
          signingPrivateJwk,
          replayStore: state,
        })
        adapters.push(
          linearAuthorization,
          createLinearAdapter(linearConfig, {
            authenticator: linearAuthorization.authenticator,
            provider: linearProvider,
            connections: linearConnections,
            audit: (record) => state.recordAudit(record),
          }),
        )
      }
      if (cloudflareConfig) {
        if (!signingPrivateJwk) throw new Error('Cloudflare external authorization is not configured.')
        const cloudflareCredentials = new D1CloudflareCredentials(
          env.DB,
          createCredentialCipher(cloudflareConfig.credentialEncryptionKey),
        )
        const cloudflareProvider = createCloudflareOAuthProvider({
          clientId: cloudflareConfig.clientId,
          clientSecret: cloudflareConfig.clientSecret,
          redirectUri: `${config.origin}/oauth/cloudflare/provider/callback`,
          authorizationOrigin: cloudflareConfig.authorizationOrigin,
        })
        const cloudflareAuthorization = await createExternalAuthorizationServer({
          origin: config.origin,
          provider: createCloudflareExternalAuthorization({
            origin: config.origin,
            provider: cloudflareProvider,
            credentials: cloudflareCredentials,
            scopes: Object.keys(cloudflareManifest.scopes),
          }),
          store: oauthStore,
          signingPrivateJwk,
          replayStore: state,
        })
        adapters.push(
          cloudflareAuthorization,
          createCloudflareAdapter(cloudflareConfig, {
            authenticator: cloudflareAuthorization.authenticator,
            provider: cloudflareProvider,
            credentials: cloudflareCredentials,
            audit: (record) => state.recordAudit(record),
            fetch,
          }),
        )
      }
      const managedProviders = [
        { definition: context7Definition, credentialEncryptionKey: env.CONTEXT7_CREDENTIAL_ENCRYPTION_KEY },
        { definition: todoistDefinition, credentialEncryptionKey: env.TODOIST_CREDENTIAL_ENCRYPTION_KEY },
        { definition: search1ApiDefinition, credentialEncryptionKey: env.SEARCH1API_CREDENTIAL_ENCRYPTION_KEY },
        { definition: fastioDefinition, credentialEncryptionKey: env.FASTIO_CREDENTIAL_ENCRYPTION_KEY },
      ]
      for (const managed of managedProviders) {
        if (!managed.credentialEncryptionKey) continue
        if (!signingPrivateJwk) {
          throw new Error(`${managed.definition.name} external authorization is not configured.`)
        }
        adapters.push(
          ...(await createConfiguredManagedProvider({
            definition: managed.definition,
            origin: config.origin,
            db: env.DB,
            credentialEncryptionKey: managed.credentialEncryptionKey,
            signingPrivateJwk,
            oauthStore,
            replayStore: state,
            audit: (record) => state.recordAudit(record),
            fetcher: fetch,
          })),
        )
      }
      const app = createApp(adapters)
      return tracing.enterSpan('adapter.router.dispatch', () => app.fetch(request, env, executionContext))
    })
  },
} satisfies ExportedHandler<Env>
