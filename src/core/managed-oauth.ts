import { z } from 'zod'
import type { CredentialCipher } from './credential-cipher.js'
import type { DynamicOAuthToken } from './dynamic-oauth-client.js'
import type { ExternalProviderAuthorization } from './external-authorization-server.js'
import { failedDependency, forbidden } from './problem.js'

export type ManagedOAuthCredential = Readonly<{
  subject: string
  displayName: string
  accessToken: string
  refreshToken: string
  expiresAt: number
  providerScopes: readonly string[]
  credentialVersion: number
}>

export type ManagedOAuthCredentials = {
  sealVerifier(verifier: string): Promise<string>
  openVerifier(verifier: string): Promise<string>
  upsert(identity: { subject: string; displayName: string }, token: DynamicOAuthToken): Promise<void>
  credential(subject: string): Promise<ManagedOAuthCredential>
  replace(credential: ManagedOAuthCredential, token: DynamicOAuthToken): Promise<boolean>
  revoke(subject: string): Promise<void>
}

export type ManagedOAuthClient = {
  authorizationUrl(state: string): Promise<{ url: string; verifier: string }>
  exchangeCode(code: string, verifier: string): Promise<DynamicOAuthToken>
  refresh(refreshToken: string): Promise<DynamicOAuthToken>
  revoke?(token: string): Promise<void>
  userInfo(accessToken: string): Promise<unknown>
}

export class D1ManagedOAuthCredentials implements ManagedOAuthCredentials {
  constructor(
    private readonly providerId: string,
    private readonly providerName: string,
    private readonly db: D1Database,
    private readonly cipher: CredentialCipher,
  ) {}

  sealVerifier(verifier: string) {
    return this.cipher.seal(verifier, `${this.providerId}:oauth-intent:pkce`)
  }

  openVerifier(verifier: string) {
    return this.cipher.open(verifier, `${this.providerId}:oauth-intent:pkce`)
  }

  async upsert(identity: { subject: string; displayName: string }, token: DynamicOAuthToken) {
    if (!token.refreshToken) throw failedDependency(`${this.providerName} did not issue the required refresh token.`)
    const context = `${this.providerId}:${identity.subject}`
    const [accessToken, refreshToken] = await Promise.all([
      this.cipher.seal(token.accessToken, `${context}:access`),
      this.cipher.seal(token.refreshToken, `${context}:refresh`),
    ])
    await this.db
      .prepare(
        `INSERT INTO managed_oauth_credential
          (provider_id, subject, display_name, access_token_ciphertext, refresh_token_ciphertext,
           token_expires_at, provider_scope_json, credential_version, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, 1, ?)
         ON CONFLICT(provider_id, subject) DO UPDATE SET display_name = excluded.display_name,
           access_token_ciphertext = excluded.access_token_ciphertext,
           refresh_token_ciphertext = excluded.refresh_token_ciphertext,
           token_expires_at = excluded.token_expires_at, provider_scope_json = excluded.provider_scope_json,
           credential_version = managed_oauth_credential.credential_version + 1,
           updated_at = excluded.updated_at`,
      )
      .bind(
        this.providerId,
        identity.subject,
        identity.displayName,
        accessToken,
        refreshToken,
        token.expiresAt,
        JSON.stringify(token.scopes),
        Date.now(),
      )
      .run()
  }

  async credential(subject: string): Promise<ManagedOAuthCredential> {
    const row = await this.db
      .prepare(
        `SELECT subject, display_name AS displayName, access_token_ciphertext AS accessToken,
                refresh_token_ciphertext AS refreshToken, token_expires_at AS expiresAt,
                provider_scope_json AS providerScopesJson, credential_version AS credentialVersion
         FROM managed_oauth_credential WHERE provider_id = ? AND subject = ?`,
      )
      .bind(this.providerId, subject)
      .first<{
        subject: string
        displayName: string
        accessToken: string
        refreshToken: string
        expiresAt: number
        providerScopesJson: string
        credentialVersion: number
      }>()
    if (!row) throw forbidden(`Active ${this.providerName} authorization is required.`)
    const context = `${this.providerId}:${row.subject}`
    const [accessToken, refreshToken] = await Promise.all([
      this.cipher.open(row.accessToken, `${context}:access`),
      this.cipher.open(row.refreshToken, `${context}:refresh`),
    ])
    return {
      ...row,
      accessToken,
      refreshToken,
      providerScopes: z.array(z.string()).parse(JSON.parse(row.providerScopesJson)),
    }
  }

  async replace(credential: ManagedOAuthCredential, token: DynamicOAuthToken) {
    const context = `${this.providerId}:${credential.subject}`
    const [accessToken, refreshToken] = await Promise.all([
      this.cipher.seal(token.accessToken, `${context}:access`),
      this.cipher.seal(token.refreshToken ?? credential.refreshToken, `${context}:refresh`),
    ])
    const result = await this.db
      .prepare(
        `UPDATE managed_oauth_credential SET access_token_ciphertext = ?, refresh_token_ciphertext = ?,
          token_expires_at = ?, provider_scope_json = ?, credential_version = credential_version + 1, updated_at = ?
         WHERE provider_id = ? AND subject = ? AND credential_version = ?`,
      )
      .bind(
        accessToken,
        refreshToken,
        token.expiresAt,
        JSON.stringify(token.scopes),
        Date.now(),
        this.providerId,
        credential.subject,
        credential.credentialVersion,
      )
      .run()
    return result.meta.changes === 1
  }

  async revoke(subject: string) {
    await this.db
      .prepare('DELETE FROM managed_oauth_credential WHERE provider_id = ? AND subject = ?')
      .bind(this.providerId, subject)
      .run()
  }
}

export function createManagedOAuthExternalAuthorization(input: {
  id: string
  name: string
  origin: string
  agentScopes: readonly string[]
  providerScopes: readonly string[]
  provider: ManagedOAuthClient
  credentials: ManagedOAuthCredentials
  identity(value: unknown): { subject: string; displayName: string }
}): ExternalProviderAuthorization {
  return {
    id: input.id,
    resource: `${input.origin}/${input.id}`,
    scopes: ['openid', 'profile', 'email', 'offline_access', ...input.agentScopes],
    async validateGrant({ subject }) {
      const credential = await input.credentials.credential(subject)
      return input.providerScopes.every((scope) => credential.providerScopes.includes(scope))
    },
    async revoke(subject) {
      const credential = await input.credentials.credential(subject)
      if (input.provider.revoke) await input.provider.revoke(credential.refreshToken)
      await input.credentials.revoke(subject)
    },
    async begin({ providerState }) {
      const started = await input.provider.authorizationUrl(providerState)
      return {
        url: started.url,
        stage: 'provider',
        data: { verifier: await input.credentials.sealVerifier(started.verifier) },
      }
    },
    async complete({ callbackUrl, intent }) {
      const code = new URL(callbackUrl).searchParams.get('code')
      if (!code) throw failedDependency(`${input.name} OAuth callback did not include a code.`)
      const encryptedVerifier = intent.providerData.verifier
      if (typeof encryptedVerifier !== 'string') {
        throw failedDependency(`${input.name} OAuth PKCE state is invalid.`)
      }
      const token = await input.provider.exchangeCode(code, await input.credentials.openVerifier(encryptedVerifier))
      const identity = input.identity(await input.provider.userInfo(token.accessToken))
      await input.credentials.upsert(identity, token)
      return {
        type: 'complete',
        grant: {
          subject: identity.subject,
          displayName: identity.displayName,
          scopes: intent.scopes,
          authorizationDetails: [],
        },
      }
    },
  }
}

export function createManagedOAuthCredentialSource(input: {
  agentScopes: readonly string[]
  providerScopes: readonly string[]
  provider: ManagedOAuthClient
  credentials: ManagedOAuthCredentials
  now?: () => number
}) {
  const now = input.now ?? Date.now
  return async (subject: string) => {
    let credential = await input.credentials.credential(subject)
    if (credential.expiresAt <= now() + 30_000) {
      const refreshed = await input.provider.refresh(credential.refreshToken)
      if (await input.credentials.replace(credential, refreshed)) {
        credential = {
          ...credential,
          accessToken: refreshed.accessToken,
          refreshToken: refreshed.refreshToken ?? credential.refreshToken,
          expiresAt: refreshed.expiresAt,
          providerScopes: refreshed.scopes,
          credentialVersion: credential.credentialVersion + 1,
        }
      } else {
        credential = await input.credentials.credential(subject)
      }
    }
    if (!input.providerScopes.every((scope) => credential.providerScopes.includes(scope))) {
      throw forbidden('The upstream OAuth grant does not contain the configured provider scopes.')
    }
    return {
      authorization: `Bearer ${credential.accessToken}`,
      scopes: input.agentScopes,
      actorType: 'oauth_delegated_user',
    }
  }
}
