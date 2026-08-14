import { unauthorized } from './problem.js'

export type ExternalOAuthClient = {
  clientId: string
  providerId: string
  clientSecretHash: string
  redirectUris: string[]
  jwksUri: string
}

export type ExternalOAuthIntent = {
  id: string
  providerId: string
  clientId: string
  redirectUri: string
  realmrootState: string
  scopes: string[]
  authorizationDetails: Array<Record<string, unknown>>
  codeChallenge: string
  providerStage: string
  providerData: Record<string, unknown>
  expiresAt: number
}

export type ExternalOAuthGrant = {
  providerId: string
  clientId: string
  subject: string
  displayName: string
  scopes: string[]
  authorizationDetails: Array<Record<string, unknown>>
}

export class D1ExternalOAuthStore {
  constructor(private readonly db: D1Database) {}

  async registerClient(input: ExternalOAuthClient) {
    await this.db
      .prepare(
        `INSERT INTO external_oauth_client
          (client_id, provider_id, client_secret_hash, redirect_uris_json, jwks_uri, created_at)
         VALUES (?, ?, ?, ?, ?, ?)`,
      )
      .bind(
        input.clientId,
        input.providerId,
        input.clientSecretHash,
        JSON.stringify(input.redirectUris),
        input.jwksUri,
        Date.now(),
      )
      .run()
  }

  async client(providerId: string, clientId: string): Promise<ExternalOAuthClient | null> {
    const row = await this.db
      .prepare(
        `SELECT client_id AS clientId, provider_id AS providerId, client_secret_hash AS clientSecretHash,
                redirect_uris_json AS redirectUrisJson, jwks_uri AS jwksUri
         FROM external_oauth_client WHERE provider_id = ? AND client_id = ?`,
      )
      .bind(providerId, clientId)
      .first<{
        clientId: string
        providerId: string
        clientSecretHash: string
        redirectUrisJson: string
        jwksUri: string
      }>()
    return row ? { ...row, redirectUris: JSON.parse(row.redirectUrisJson) as string[] } : null
  }

  async createIntent(input: ExternalOAuthIntent, providerStateHash: string) {
    const now = Date.now()
    await this.db
      .prepare(
        `INSERT INTO external_oauth_intent
          (id, provider_id, client_id, redirect_uri, realmroot_state, scope_json,
           authorization_details_json, code_challenge, provider_state_hash, provider_stage,
           provider_data_json, status, expires_at, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending', ?, ?, ?)`,
      )
      .bind(
        input.id,
        input.providerId,
        input.clientId,
        input.redirectUri,
        input.realmrootState,
        JSON.stringify(input.scopes),
        JSON.stringify(input.authorizationDetails),
        input.codeChallenge,
        providerStateHash,
        input.providerStage,
        JSON.stringify(input.providerData),
        input.expiresAt,
        now,
        now,
      )
      .run()
  }

  async intentByProviderState(providerStateHash: string): Promise<ExternalOAuthIntent> {
    const row = await this.db
      .prepare(
        `SELECT id, provider_id AS providerId, client_id AS clientId, redirect_uri AS redirectUri,
                realmroot_state AS realmrootState, scope_json AS scopesJson,
                authorization_details_json AS authorizationDetailsJson, code_challenge AS codeChallenge,
                provider_stage AS providerStage, provider_data_json AS providerDataJson, expires_at AS expiresAt
         FROM external_oauth_intent
         WHERE provider_state_hash = ? AND status = 'pending' AND expires_at > ?`,
      )
      .bind(providerStateHash, Date.now())
      .first<IntentRow>()
    if (!row) throw unauthorized('External OAuth state is invalid or expired.')
    return parseIntent(row)
  }

  async advanceIntent(input: {
    id: string
    expectedStage: string
    providerStateHash: string
    providerStage: string
    providerData: Record<string, unknown>
  }) {
    const result = await this.db
      .prepare(
        `UPDATE external_oauth_intent
         SET provider_state_hash = ?, provider_stage = ?, provider_data_json = ?, updated_at = ?
         WHERE id = ? AND provider_stage = ? AND status = 'pending' AND expires_at > ?`,
      )
      .bind(
        input.providerStateHash,
        input.providerStage,
        JSON.stringify(input.providerData),
        Date.now(),
        input.id,
        input.expectedStage,
        Date.now(),
      )
      .run()
    if (result.meta.changes !== 1) throw unauthorized('External OAuth state changed during authorization.')
  }

  async completeIntent(intent: ExternalOAuthIntent, grant: ExternalOAuthGrant, code: string) {
    const now = Date.now()
    const results = await this.db.batch([
      this.db
        .prepare(
          `INSERT INTO external_oauth_code
            (code_hash, provider_id, client_id, redirect_uri, subject, display_name, scope_json,
             authorization_details_json, code_challenge, expires_at, created_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .bind(
          await sha256(code),
          grant.providerId,
          grant.clientId,
          intent.redirectUri,
          grant.subject,
          grant.displayName,
          JSON.stringify(grant.scopes),
          JSON.stringify(grant.authorizationDetails),
          intent.codeChallenge,
          now + 5 * 60_000,
          now,
        ),
      this.db
        .prepare(
          "UPDATE external_oauth_intent SET status = 'completed', updated_at = ? WHERE id = ? AND status = 'pending'",
        )
        .bind(now, intent.id),
    ])
    if (results[1]?.meta.changes !== 1) throw unauthorized('External OAuth authorization was already completed.')
  }

  async cancelIntent(intent: ExternalOAuthIntent) {
    const result = await this.db
      .prepare("DELETE FROM external_oauth_intent WHERE id = ? AND status = 'pending'")
      .bind(intent.id)
      .run()
    if (result.meta.changes !== 1) throw unauthorized('External OAuth authorization was already completed.')
  }

  async consumeCode(input: { code: string; clientId: string; redirectUri: string; verifier: string }) {
    const codeHash = await sha256(input.code)
    const row = await this.db
      .prepare(
        `SELECT provider_id AS providerId, client_id AS clientId, redirect_uri AS redirectUri,
                subject, display_name AS displayName, scope_json AS scopesJson,
                authorization_details_json AS authorizationDetailsJson,
                code_challenge AS codeChallenge, expires_at AS expiresAt
         FROM external_oauth_code WHERE code_hash = ? AND client_id = ?`,
      )
      .bind(codeHash, input.clientId)
      .first<GrantRow & { redirectUri: string; codeChallenge: string; expiresAt: number }>()
    if (
      !row ||
      row.redirectUri !== input.redirectUri ||
      row.expiresAt <= Date.now() ||
      (await sha256Base64Url(input.verifier)) !== row.codeChallenge
    ) {
      throw unauthorized('Authorization code is invalid.')
    }
    const deleted = await this.db.prepare('DELETE FROM external_oauth_code WHERE code_hash = ?').bind(codeHash).run()
    if (deleted.meta.changes !== 1) throw unauthorized('Authorization code was already used.')
    return parseGrant(row)
  }

  async createRefresh(grant: ExternalOAuthGrant, token: string) {
    const now = Date.now()
    await this.db
      .prepare(
        `INSERT INTO external_oauth_refresh
          (token_hash, provider_id, client_id, subject, display_name, scope_json,
           authorization_details_json, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .bind(
        await sha256(token),
        grant.providerId,
        grant.clientId,
        grant.subject,
        grant.displayName,
        JSON.stringify(grant.scopes),
        JSON.stringify(grant.authorizationDetails),
        now,
        now,
      )
      .run()
  }

  async refreshGrant(token: string, clientId: string) {
    const row = await this.db
      .prepare(
        `SELECT provider_id AS providerId, client_id AS clientId, subject,
                display_name AS displayName, scope_json AS scopesJson,
                authorization_details_json AS authorizationDetailsJson
         FROM external_oauth_refresh
         WHERE token_hash = ? AND client_id = ? AND revoked_at IS NULL`,
      )
      .bind(await sha256(token), clientId)
      .first<GrantRow>()
    if (!row) throw unauthorized('Refresh credential is invalid.')
    return parseGrant(row)
  }

  async revokeRefresh(token: string, clientId: string) {
    const row = await this.db
      .prepare(
        `UPDATE external_oauth_refresh SET revoked_at = ?, updated_at = ?
         WHERE token_hash = ? AND client_id = ? AND revoked_at IS NULL
         RETURNING provider_id AS providerId, client_id AS clientId, subject,
           display_name AS displayName, scope_json AS scopesJson,
           authorization_details_json AS authorizationDetailsJson`,
      )
      .bind(Date.now(), Date.now(), await sha256(token), clientId)
      .first<GrantRow>()
    if (!row) return null
    const active = await this.db
      .prepare(
        `SELECT COUNT(*) AS count FROM external_oauth_refresh
         WHERE provider_id = ? AND subject = ? AND revoked_at IS NULL`,
      )
      .bind(row.providerId, row.subject)
      .first<{ count: number }>()
    return { grant: parseGrant(row), lastForSubject: (active?.count ?? 0) === 0 }
  }

  async recordAccess(input: { jti: string; providerId: string; clientId: string; subject: string; expiresAt: number }) {
    await this.db
      .prepare(
        `INSERT INTO external_oauth_access
          (jti, provider_id, client_id, subject, expires_at, created_at)
         VALUES (?, ?, ?, ?, ?, ?)`,
      )
      .bind(input.jti, input.providerId, input.clientId, input.subject, input.expiresAt, Date.now())
      .run()
  }

  async activeAccess(jti: string) {
    const row = await this.db
      .prepare('SELECT revoked_at AS revokedAt, expires_at AS expiresAt FROM external_oauth_access WHERE jti = ?')
      .bind(jti)
      .first<{ revokedAt: number | null; expiresAt: number }>()
    return Boolean(row && !row.revokedAt && row.expiresAt > Date.now())
  }

  async revokeAccess(jti: string, clientId: string) {
    await this.db
      .prepare('UPDATE external_oauth_access SET revoked_at = ? WHERE jti = ? AND client_id = ?')
      .bind(Date.now(), jti, clientId)
      .run()
  }
}

type IntentRow = {
  id: string
  providerId: string
  clientId: string
  redirectUri: string
  realmrootState: string
  scopesJson: string
  authorizationDetailsJson: string
  codeChallenge: string
  providerStage: string
  providerDataJson: string
  expiresAt: number
}

type GrantRow = {
  providerId: string
  clientId: string
  subject: string
  displayName: string
  scopesJson: string
  authorizationDetailsJson: string
}

function parseIntent(row: IntentRow): ExternalOAuthIntent {
  return {
    ...row,
    scopes: JSON.parse(row.scopesJson) as string[],
    authorizationDetails: JSON.parse(row.authorizationDetailsJson) as Array<Record<string, unknown>>,
    providerData: JSON.parse(row.providerDataJson) as Record<string, unknown>,
  }
}

function parseGrant(row: GrantRow): ExternalOAuthGrant {
  return {
    providerId: row.providerId,
    clientId: row.clientId,
    subject: row.subject,
    displayName: row.displayName,
    scopes: JSON.parse(row.scopesJson) as string[],
    authorizationDetails: JSON.parse(row.authorizationDetailsJson) as Array<Record<string, unknown>>,
  }
}

export async function sha256(value: string) {
  const bytes = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value))
  return Array.from(new Uint8Array(bytes), (byte) => byte.toString(16).padStart(2, '0')).join('')
}

export async function sha256Base64Url(value: string) {
  const bytes = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value))
  return btoa(String.fromCharCode(...new Uint8Array(bytes)))
    .replaceAll('+', '-')
    .replaceAll('/', '_')
    .replace(/=+$/, '')
}
