import { z } from 'zod'
import type { CredentialCipher } from '../../core/credential-cipher.js'
import type { createDynamicOAuthClient, DynamicOAuthToken } from '../../core/dynamic-oauth-client.js'
import type { ExternalProviderAuthorization } from '../../core/external-authorization-server.js'
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

export type Context7OAuthClient = ReturnType<typeof createDynamicOAuthClient>
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
  return {
    id: 'context7',
    resource: `${input.origin}/context7`,
    scopes: ['openid', 'profile', 'email', 'offline_access', context7AgentScope],
    async validateGrant({ subject }) {
      await input.credentials.credential(subject)
      return true
    },
    async revoke(subject) {
      const credential = await input.credentials.credential(subject)
      await input.provider.revoke(credential.refreshToken)
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
      if (!code) throw failedDependency('Context7 OAuth callback did not include a code.')
      const encryptedVerifier = intent.providerData.verifier
      if (typeof encryptedVerifier !== 'string') throw failedDependency('Context7 OAuth PKCE state is invalid.')
      const token = await input.provider.exchangeCode(code, await input.credentials.openVerifier(encryptedVerifier))
      const identity = identitySchema.parse(await input.provider.userInfo(token.accessToken))
      const resolved = {
        subject: identity.sub,
        displayName: identity.name ?? identity.preferred_username ?? identity.email ?? identity.sub,
      }
      await input.credentials.upsert(resolved, token)
      return {
        type: 'complete',
        grant: {
          subject: resolved.subject,
          displayName: resolved.displayName,
          scopes: intent.scopes,
          authorizationDetails: [],
        },
      }
    },
  }
}
