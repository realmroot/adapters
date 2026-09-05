import type { JWK } from 'jose'
import type { AppConfig } from '../config.js'
import type { AdapterModule } from '../core/adapter.js'
import { type ConfiguredManagedProvider, createConfiguredManagedProvider } from '../core/configured-managed-provider.js'
import { createCredentialCipher } from '../core/credential-cipher.js'
import { createExternalAuthorizationServer } from '../core/external-authorization-server.js'
import type { D1ExternalOAuthStore } from '../core/external-oauth-store.js'
import { createCloudflareAdapter } from '../providers/cloudflare/adapter.js'
import { loadCloudflareConfig } from '../providers/cloudflare/config.js'
import { cloudflareManifest } from '../providers/cloudflare/manifest.js'
import {
  createCloudflareExternalAuthorization,
  createCloudflareOAuthProvider,
  D1CloudflareCredentials,
} from '../providers/cloudflare/oauth.js'
import { createGitHubAdapter } from '../providers/github/adapter.js'
import { createGitHubConnectionProvider, createGitHubProvider } from '../providers/github/client.js'
import { loadGitHubConfig } from '../providers/github/config.js'
import { D1GitHubConnections } from '../providers/github/connections.js'
import { createGitHubExternalAuthorization } from '../providers/github/external-authorization.js'
import { permissionsToScopes } from '../providers/github/permissions.js'
import { createLinearAdapter } from '../providers/linear/adapter.js'
import { createLinearProvider } from '../providers/linear/client.js'
import { loadLinearConfig } from '../providers/linear/config.js'
import { D1LinearConnections } from '../providers/linear/connections.js'
import { createLinearCredentialCipher } from '../providers/linear/credentials.js'
import { createLinearExternalAuthorization } from '../providers/linear/external-authorization.js'
import { linearScopes } from '../providers/linear/scopes.js'
import type { D1RuntimeState } from '../storage/d1-runtime-state.js'

export type ProviderRuntime = {
  env: Env
  config: AppConfig
  executionContext: ExecutionContext
  state: D1RuntimeState
  oauthStore: D1ExternalOAuthStore
  signingPrivateJwk: JWK | undefined
}

export async function createGitHubModules({
  env,
  config,
  executionContext,
  state,
  oauthStore,
  signingPrivateJwk,
}: ProviderRuntime): Promise<AdapterModule[]> {
  const githubConfig = loadGitHubConfig(env, config)
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
  return adapters
}

export async function createLinearModules({
  env,
  config,
  state,
  oauthStore,
  signingPrivateJwk,
}: ProviderRuntime): Promise<AdapterModule[]> {
  const linearConfig = loadLinearConfig(env, config)
  const adapters: AdapterModule[] = []
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
  return adapters
}

export async function createCloudflareModules({
  env,
  config,
  state,
  oauthStore,
  signingPrivateJwk,
}: ProviderRuntime): Promise<AdapterModule[]> {
  const cloudflareConfig = loadCloudflareConfig(env, config)
  const adapters: AdapterModule[] = []
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
  return adapters
}

export async function createManagedModules(
  definition: ConfiguredManagedProvider,
  credentialEncryptionKey: string | undefined,
  { env, config, state, oauthStore, signingPrivateJwk }: ProviderRuntime,
): Promise<AdapterModule[]> {
  if (!credentialEncryptionKey) return []
  if (!signingPrivateJwk) throw new Error(`${definition.name} external authorization is not configured.`)
  return createConfiguredManagedProvider({
    definition,
    origin: config.origin,
    db: env.DB,
    credentialEncryptionKey,
    signingPrivateJwk,
    oauthStore,
    replayStore: state,
    audit: (record) => state.recordAudit(record),
    fetcher: fetch,
  })
}
