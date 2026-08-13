import { z } from 'zod'
import type { CredentialCipher } from '../../core/credential-cipher.js'
import type { ExternalProviderAuthorization } from '../../core/external-authorization-server.js'
import { failedDependency, forbidden } from '../../core/problem.js'

const tokenSchema = z.object({
  access_token: z.string().min(1),
  refresh_token: z.string().min(1),
  expires_in: z.number().int().positive(),
  scope: z.union([z.string(), z.array(z.string())]),
})
const userInfoSchema = z
  .object({
    sub: z.string().min(1),
    name: z.string().min(1).optional(),
    preferred_username: z.string().min(1).optional(),
    email: z.string().email().optional(),
  })
  .passthrough()

export type CloudflareProviderToken = {
  accessToken: string
  refreshToken: string
  expiresAt: number
  scopes: string[]
}

export type CloudflareCredential = CloudflareProviderToken & {
  subject: string
  displayName: string
  credentialVersion: number
}

export type CloudflareOAuthProvider = ReturnType<typeof createCloudflareOAuthProvider>

export function createCloudflareOAuthProvider(input: {
  clientId: string
  clientSecret: string
  redirectUri: string
  authorizationOrigin: string
  fetcher?: typeof fetch
  now?: () => number
}) {
  const fetcher = input.fetcher ?? fetch
  const now = input.now ?? Date.now
  return {
    authorizationUrl(state: string, scopes: string[]) {
      const url = new URL('/oauth2/auth', input.authorizationOrigin)
      url.searchParams.set('client_id', input.clientId)
      url.searchParams.set('redirect_uri', input.redirectUri)
      url.searchParams.set('response_type', 'code')
      url.searchParams.set('scope', scopes.join(' '))
      url.searchParams.set('state', state)
      return url.toString()
    },
    exchangeCode(code: string) {
      return tokenRequest({ grant_type: 'authorization_code', code, redirect_uri: input.redirectUri })
    },
    refresh(refreshToken: string) {
      return tokenRequest({ grant_type: 'refresh_token', refresh_token: refreshToken })
    },
    async revoke(refreshToken: string) {
      const response = await fetcher(new URL('/oauth2/revoke', input.authorizationOrigin), {
        method: 'POST',
        headers: { 'content-type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({ token: refreshToken, token_type_hint: 'refresh_token' }),
        signal: AbortSignal.timeout(10_000),
      })
      if (!response.ok) throw failedDependency(`Cloudflare rejected OAuth revocation with ${response.status}.`)
    },
    async userInfo(accessToken: string) {
      const response = await fetcher(new URL('/oauth2/userinfo', input.authorizationOrigin), {
        headers: { authorization: `Bearer ${accessToken}` },
        signal: AbortSignal.timeout(10_000),
      })
      if (!response.ok) throw failedDependency(`Cloudflare rejected OAuth userinfo with ${response.status}.`)
      const identity = userInfoSchema.parse(await response.json())
      return {
        subject: identity.sub,
        displayName: identity.name ?? identity.preferred_username ?? identity.email ?? identity.sub,
      }
    },
  }

  async function tokenRequest(parameters: Record<string, string>): Promise<CloudflareProviderToken> {
    const credentials = btoa(`${encodeURIComponent(input.clientId)}:${encodeURIComponent(input.clientSecret)}`)
    const response = await fetcher(new URL('/oauth2/token', input.authorizationOrigin), {
      method: 'POST',
      headers: {
        accept: 'application/json',
        authorization: `Basic ${credentials}`,
        'content-type': 'application/x-www-form-urlencoded',
      },
      body: new URLSearchParams(parameters),
      signal: AbortSignal.timeout(10_000),
    })
    if (!response.ok) throw failedDependency(`Cloudflare rejected OAuth token exchange with ${response.status}.`)
    const token = tokenSchema.parse(await response.json())
    return {
      accessToken: token.access_token,
      refreshToken: token.refresh_token,
      expiresAt: now() + token.expires_in * 1000,
      scopes: normalizeScopes(token.scope),
    }
  }
}

export class D1CloudflareCredentials {
  constructor(
    private readonly db: D1Database,
    private readonly cipher: CredentialCipher,
  ) {}

  async upsert(identity: { subject: string; displayName: string }, token: CloudflareProviderToken) {
    const context = `cloudflare:${identity.subject}`
    const [accessToken, refreshToken] = await Promise.all([
      this.cipher.seal(token.accessToken, `${context}:access`),
      this.cipher.seal(token.refreshToken, `${context}:refresh`),
    ])
    await this.db
      .prepare(
        `INSERT INTO cloudflare_external_credential
          (subject, display_name, access_token_ciphertext, refresh_token_ciphertext, token_expires_at,
           scope_json, credential_version, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, 1, ?)
         ON CONFLICT(subject) DO UPDATE SET display_name = excluded.display_name,
           access_token_ciphertext = excluded.access_token_ciphertext,
           refresh_token_ciphertext = excluded.refresh_token_ciphertext,
           token_expires_at = excluded.token_expires_at, scope_json = excluded.scope_json,
           credential_version = cloudflare_external_credential.credential_version + 1,
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

  async credential(subject: string): Promise<CloudflareCredential> {
    const row = await this.db
      .prepare(
        `SELECT subject, display_name AS displayName, access_token_ciphertext AS accessToken,
                refresh_token_ciphertext AS refreshToken, token_expires_at AS expiresAt,
                scope_json AS scopesJson, credential_version AS credentialVersion
         FROM cloudflare_external_credential WHERE subject = ?`,
      )
      .bind(subject)
      .first<{
        subject: string
        displayName: string
        accessToken: string
        refreshToken: string
        expiresAt: number
        scopesJson: string
        credentialVersion: number
      }>()
    if (!row) throw forbidden('Active Cloudflare authorization is required.')
    const context = `cloudflare:${row.subject}`
    const [accessToken, refreshToken] = await Promise.all([
      this.cipher.open(row.accessToken, `${context}:access`),
      this.cipher.open(row.refreshToken, `${context}:refresh`),
    ])
    return {
      subject: row.subject,
      displayName: row.displayName,
      accessToken,
      refreshToken,
      expiresAt: row.expiresAt,
      scopes: z.array(z.string()).parse(JSON.parse(row.scopesJson)),
      credentialVersion: row.credentialVersion,
    }
  }

  async replace(credential: CloudflareCredential, token: CloudflareProviderToken) {
    const context = `cloudflare:${credential.subject}`
    const [accessToken, refreshToken] = await Promise.all([
      this.cipher.seal(token.accessToken, `${context}:access`),
      this.cipher.seal(token.refreshToken, `${context}:refresh`),
    ])
    const result = await this.db
      .prepare(
        `UPDATE cloudflare_external_credential SET access_token_ciphertext = ?, refresh_token_ciphertext = ?,
          token_expires_at = ?, scope_json = ?, credential_version = credential_version + 1, updated_at = ?
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
    await this.db.prepare('DELETE FROM cloudflare_external_credential WHERE subject = ?').bind(subject).run()
  }
}

export function createCloudflareExternalAuthorization(input: {
  origin: string
  provider: ReturnType<typeof createCloudflareOAuthProvider>
  credentials: D1CloudflareCredentials
  scopes: readonly string[]
}): ExternalProviderAuthorization {
  return {
    id: 'cloudflare',
    resource: `${input.origin}/cloudflare`,
    scopes: ['openid', 'offline_access', ...input.scopes],
    async validateGrant({ subject, scopes }) {
      const credential = await input.credentials.credential(subject)
      return scopes.every((scope) => scope === 'offline_access' || credential.scopes.includes(scope))
    },
    async revoke(subject) {
      const credential = await input.credentials.credential(subject)
      await input.provider.revoke(credential.refreshToken)
      await input.credentials.revoke(subject)
    },
    begin({ providerState, scopes }) {
      const providerScopes = scopes.filter((scope) => scope !== 'offline_access')
      if (!providerScopes.includes('openid')) providerScopes.unshift('openid')
      return { url: input.provider.authorizationUrl(providerState, providerScopes), stage: 'provider' }
    },
    async complete({ callbackUrl, intent }) {
      const code = new URL(callbackUrl).searchParams.get('code')
      if (!code) throw failedDependency('Cloudflare OAuth callback did not include a code.')
      const token = await input.provider.exchangeCode(code)
      const identity = await input.provider.userInfo(token.accessToken)
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

function normalizeScopes(value: string | string[]) {
  return [...new Set((Array.isArray(value) ? value : value.split(/\s+/)).filter(Boolean))].sort()
}
