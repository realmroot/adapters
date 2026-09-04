import { z } from 'zod'
import type { CredentialCipher } from '../../core/credential-cipher.js'
import type { DynamicOAuthToken } from '../../core/dynamic-oauth-client.js'
import type { ExternalProviderAuthorization } from '../../core/external-authorization-server.js'
import { createManagedOAuthExternalAuthorization, type ManagedOAuthClient } from '../../core/managed-oauth.js'
import { failedDependency, forbidden } from '../../core/problem.js'

const identitySchema = z
  .object({
    sub: z.string().min(1),
    name: z.string().min(1).optional(),
    preferred_username: z.string().min(1).optional(),
    email: z.string().email().optional(),
  })
  .passthrough()

export const context7AgentScope = 'documentation:read'
export const context7ProviderScopes = ['openid', 'profile', 'email', 'offline_access'] as const

export type Context7OAuthClient = ManagedOAuthClient
export type Context7Credential = Readonly<{
  subject: string
  displayName: string
  accessToken: string
  refreshToken: string
  expiresAt: number
  providerScopes: readonly string[]
  credentialVersion: number
}>

export class D1Context7Credentials {
  constructor(
    private readonly db: D1Database,
    private readonly cipher: CredentialCipher,
  ) {}

  sealVerifier(verifier: string) {
    return this.cipher.seal(verifier, 'context7:oauth-intent:pkce')
  }

  openVerifier(verifier: string) {
    return this.cipher.open(verifier, 'context7:oauth-intent:pkce')
  }

  async upsert(identity: { subject: string; displayName: string }, token: DynamicOAuthToken) {
    if (!token.refreshToken) throw failedDependency('Context7 did not issue the required refresh token.')
    const context = `context7:${identity.subject}`
    const [accessToken, refreshToken] = await Promise.all([
      this.cipher.seal(token.accessToken, `${context}:access`),
      this.cipher.seal(token.refreshToken, `${context}:refresh`),
    ])
    await this.db
      .prepare(
        `INSERT INTO context7_external_credential
          (subject, display_name, access_token_ciphertext, refresh_token_ciphertext, token_expires_at,
           provider_scope_json, credential_version, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, 1, ?)
         ON CONFLICT(subject) DO UPDATE SET display_name = excluded.display_name,
           access_token_ciphertext = excluded.access_token_ciphertext,
           refresh_token_ciphertext = excluded.refresh_token_ciphertext,
           token_expires_at = excluded.token_expires_at, provider_scope_json = excluded.provider_scope_json,
           credential_version = context7_external_credential.credential_version + 1,
           updated_at = excluded.updated_at`,
      )
      .bind(
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

  async credential(subject: string): Promise<Context7Credential> {
    const row = await this.db
      .prepare(
        `SELECT subject, display_name AS displayName, access_token_ciphertext AS accessToken,
                refresh_token_ciphertext AS refreshToken, token_expires_at AS expiresAt,
                provider_scope_json AS providerScopesJson, credential_version AS credentialVersion
         FROM context7_external_credential WHERE subject = ?`,
      )
      .bind(subject)
      .first<{
        subject: string
        displayName: string
        accessToken: string
        refreshToken: string
        expiresAt: number
        providerScopesJson: string
        credentialVersion: number
      }>()
    if (!row) throw forbidden('Active Context7 authorization is required.')
    const context = `context7:${row.subject}`
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

  async replace(credential: Context7Credential, token: DynamicOAuthToken) {
    const refreshTokenValue = token.refreshToken ?? credential.refreshToken
    const context = `context7:${credential.subject}`
    const [accessToken, refreshToken] = await Promise.all([
      this.cipher.seal(token.accessToken, `${context}:access`),
      this.cipher.seal(refreshTokenValue, `${context}:refresh`),
    ])
    const result = await this.db
      .prepare(
        `UPDATE context7_external_credential SET access_token_ciphertext = ?, refresh_token_ciphertext = ?,
          token_expires_at = ?, provider_scope_json = ?, credential_version = credential_version + 1, updated_at = ?
         WHERE subject = ? AND credential_version = ?`,
      )
      .bind(
        accessToken,
        refreshToken,
        token.expiresAt,
        JSON.stringify(token.scopes),
        Date.now(),
        credential.subject,
        credential.credentialVersion,
      )
      .run()
    return result.meta.changes === 1
  }

  async revoke(subject: string) {
    await this.db.prepare('DELETE FROM context7_external_credential WHERE subject = ?').bind(subject).run()
  }
}

export function createContext7ExternalAuthorization(input: {
  origin: string
  provider: Context7OAuthClient
  credentials: D1Context7Credentials
}): ExternalProviderAuthorization {
  return createManagedOAuthExternalAuthorization({
    id: 'context7',
    name: 'Context7',
    origin: input.origin,
    agentScopes: [context7AgentScope],
    providerScopes: context7ProviderScopes,
    provider: input.provider,
    credentials: input.credentials,
    identity(value) {
      const identity = identitySchema.parse(value)
      return {
        subject: identity.sub,
        displayName: identity.name ?? identity.preferred_username ?? identity.email ?? identity.sub,
      }
    },
  })
}
