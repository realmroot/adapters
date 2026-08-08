import { z } from 'zod'
import type { BrokeredConnectionRequest } from '../core/connection-request.js'
import { sha256Base64Url } from '../core/digest.js'
import { badRequest, forbidden, unauthorized } from '../core/problem.js'
import type { GitHubInstallation, GitHubUser } from '../providers/github/types.js'

const intentSchema = z.object({
  requestId: z.string(),
  connectionId: z.string(),
  expectedExternalSubject: z.string().nullable(),
  ownerSubject: z.string(),
  realmrootState: z.string(),
  callbackUri: z.url(),
  codeChallenge: z.string(),
  scopesJson: z.string(),
  expectedInstallationId: z.number().int().positive().nullable(),
  status: z.enum(['pending_oauth', 'awaiting_install', 'completed', 'exchanged']),
  expiresAt: z.number().int(),
})

export type GitHubConnectionIntent = z.infer<typeof intentSchema>

export interface GitHubConnectionStore {
  create(request: BrokeredConnectionRequest, providerState: string, now?: number): Promise<void>
  findByProviderState(
    providerState: string,
    expectedStatus: 'pending_oauth' | 'awaiting_install',
  ): Promise<GitHubConnectionIntent>
  rotateProviderState(
    requestId: string,
    nextState: string,
    status: 'pending_oauth' | 'awaiting_install',
    expectedInstallationId: number | null,
  ): Promise<void>
  complete(
    intent: GitHubConnectionIntent,
    user: GitHubUser,
    installations: GitHubInstallation[],
    code: string,
  ): Promise<void>
  exchange(
    code: string,
    verifier: string,
    connectionRequestId: string,
  ): Promise<{
    intent: GitHubConnectionIntent
    brokerReference: string
    binding: { githubUserId: number; githubLogin: string; displayName: string; scopesJson: string }
    contexts: Array<{ installationId: number; accountLogin: string; targetType: string }>
  }>
  activeInstallationIdsForOwner(ownerSubject: string): Promise<number[]>
  revoke(input: { brokerReference: string; ownerSubject: string; jti: string; expiresAt: number }): Promise<void>
}

export class D1GitHubConnections implements GitHubConnectionStore {
  constructor(private readonly db: D1Database) {}

  async create(request: BrokeredConnectionRequest, providerState: string, now = Date.now()) {
    const result = await this.db
      .prepare(
        `INSERT OR IGNORE INTO github_connection_intent
          (request_id, connection_id, expected_external_subject, owner_subject, realmroot_state, callback_uri, code_challenge, scopes_json,
           provider_state_hash, status, expires_at, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending_oauth', ?, ?, ?)`,
      )
      .bind(
        request.jti,
        request.connection_id,
        request.expected_external_subject,
        request.sub,
        request.state,
        request.callback_uri,
        request.code_challenge,
        JSON.stringify(request.scope.split(/\s+/).filter(Boolean)),
        await sha256Base64Url(providerState),
        now + 10 * 60 * 1000,
        now,
        now,
      )
      .run()
    if (result.meta.changes !== 1) throw badRequest('The account connection request was already used.')
  }

  async findByProviderState(providerState: string, expectedStatus: 'pending_oauth' | 'awaiting_install') {
    const row = await this.db
      .prepare(
        `SELECT request_id AS requestId, connection_id AS connectionId, expected_external_subject AS expectedExternalSubject, owner_subject AS ownerSubject,
                realmroot_state AS realmrootState, callback_uri AS callbackUri, code_challenge AS codeChallenge,
                scopes_json AS scopesJson, expected_installation_id AS expectedInstallationId,
                status, expires_at AS expiresAt
         FROM github_connection_intent WHERE provider_state_hash = ?`,
      )
      .bind(await sha256Base64Url(providerState))
      .first()
    const intent = intentSchema.parse(row)
    if (intent.status !== expectedStatus || intent.expiresAt <= Date.now()) {
      throw unauthorized('The GitHub account connection state is invalid or expired.')
    }
    return intent
  }

  async rotateProviderState(
    requestId: string,
    nextState: string,
    status: 'pending_oauth' | 'awaiting_install',
    expectedInstallationId: number | null,
  ) {
    const result = await this.db
      .prepare(
        `UPDATE github_connection_intent
         SET provider_state_hash = ?, status = ?, expected_installation_id = ?, updated_at = ?
         WHERE request_id = ? AND expires_at > ?`,
      )
      .bind(await sha256Base64Url(nextState), status, expectedInstallationId, Date.now(), requestId, Date.now())
      .run()
    if (result.meta.changes !== 1) throw unauthorized('The GitHub account connection request expired.')
  }

  async complete(intent: GitHubConnectionIntent, user: GitHubUser, installations: GitHubInstallation[], code: string) {
    const now = Date.now()
    const existing = await this.db
      .prepare(
        `SELECT broker_reference AS brokerReference, github_user_id AS githubUserId
         FROM github_connection_binding WHERE owner_subject = ? AND status = 'active'`,
      )
      .bind(intent.ownerSubject)
      .first<{ brokerReference: string; githubUserId: number }>()
    if (intent.expectedExternalSubject !== null && intent.expectedExternalSubject !== String(user.id)) {
      throw badRequest('Disconnect the current GitHub account before connecting another account.')
    }
    if (existing && existing.githubUserId !== user.id) {
      throw badRequest('The active GitHub account connection changed during authorization.')
    }
    const brokerReference = existing?.brokerReference ?? intent.connectionId
    const statements: D1PreparedStatement[] = [
      this.db
        .prepare(
          `INSERT INTO github_connection_binding
            (broker_reference, owner_subject, github_user_id, github_login, display_name, scopes_json, status, created_at, updated_at)
           VALUES (?, ?, ?, ?, ?, ?, 'active', ?, ?)
           ON CONFLICT(broker_reference) DO UPDATE SET owner_subject = excluded.owner_subject,
             github_user_id = excluded.github_user_id,
             github_login = excluded.github_login, display_name = excluded.display_name,
             scopes_json = excluded.scopes_json, status = 'active', updated_at = excluded.updated_at`,
        )
        .bind(
          brokerReference,
          intent.ownerSubject,
          user.id,
          user.login,
          user.name ?? user.login,
          intent.scopesJson,
          now,
          now,
        ),
      this.db.prepare('DELETE FROM github_connection_context WHERE broker_reference = ?').bind(brokerReference),
      ...installations.map((installation) =>
        this.db
          .prepare(
            `INSERT INTO github_connection_context
              (broker_reference, installation_id, account_login, target_type, created_at)
             VALUES (?, ?, ?, ?, ?)`,
          )
          .bind(brokerReference, installation.id, installation.accountLogin, installation.targetType, now),
      ),
      this.db
        .prepare(
          `UPDATE github_connection_intent
           SET github_user_id = ?, github_login = ?, authorization_code_hash = ?, status = 'completed', updated_at = ?
           WHERE request_id = ? AND status = 'pending_oauth'`,
        )
        .bind(user.id, user.login, await sha256Base64Url(code), now, intent.requestId),
    ]
    const results = await this.db.batch(statements)
    if (results.at(-1)?.meta.changes !== 1)
      throw unauthorized('The GitHub account connection request was already used.')
  }

  async exchange(code: string, verifier: string, connectionRequestId: string) {
    const codeHash = await sha256Base64Url(code)
    const row = await this.db
      .prepare(
        `SELECT request_id AS requestId, connection_id AS connectionId, expected_external_subject AS expectedExternalSubject, owner_subject AS ownerSubject,
                realmroot_state AS realmrootState, callback_uri AS callbackUri, code_challenge AS codeChallenge,
                scopes_json AS scopesJson, expected_installation_id AS expectedInstallationId,
                status, expires_at AS expiresAt
         FROM github_connection_intent WHERE authorization_code_hash = ?`,
      )
      .bind(codeHash)
      .first()
    const intent = intentSchema.parse(row)
    if (intent.status !== 'completed' || intent.expiresAt <= Date.now())
      throw unauthorized('Connection code is invalid.')
    if (intent.requestId !== connectionRequestId) throw forbidden('Connection request binding is invalid.')
    if ((await sha256Base64Url(verifier)) !== intent.codeChallenge) throw forbidden('Connection PKCE proof is invalid.')
    const binding = await this.db
      .prepare(
        `SELECT broker_reference AS brokerReference, github_user_id AS githubUserId,
                github_login AS githubLogin, display_name AS displayName,
                scopes_json AS scopesJson
         FROM github_connection_binding WHERE owner_subject = ? AND status = 'active'`,
      )
      .bind(intent.ownerSubject)
      .first<{
        brokerReference: string
        githubUserId: number
        githubLogin: string
        displayName: string
        scopesJson: string
      }>()
    if (!binding) throw unauthorized('GitHub account connection is unavailable.')
    const contexts = await this.contexts(binding.brokerReference)
    const consumed = await this.db
      .prepare(
        "UPDATE github_connection_intent SET status = 'exchanged', updated_at = ? WHERE request_id = ? AND status = 'completed'",
      )
      .bind(Date.now(), intent.requestId)
      .run()
    if (consumed.meta.changes !== 1) throw unauthorized('Connection code was already used.')
    return { intent, brokerReference: binding.brokerReference, binding, contexts }
  }

  async activeInstallationIdsForOwner(ownerSubject: string) {
    const binding = await this.db
      .prepare(
        "SELECT broker_reference AS brokerReference FROM github_connection_binding WHERE owner_subject = ? AND status = 'active'",
      )
      .bind(ownerSubject)
      .first<{ brokerReference: string }>()
    if (!binding) throw forbidden('Active GitHub account connection is required.')
    return (await this.contexts(binding.brokerReference)).map((context) => context.installationId)
  }

  async revoke(input: { brokerReference: string; ownerSubject: string; jti: string; expiresAt: number }) {
    const binding = await this.db
      .prepare('SELECT status FROM github_connection_binding WHERE broker_reference = ? AND owner_subject = ?')
      .bind(input.brokerReference, input.ownerSubject)
      .first<{ status: 'active' | 'revoked' }>()
    if (!binding) throw forbidden('The brokered GitHub account connection was not found.')

    const now = Date.now()
    try {
      await this.db.batch([
        this.db.prepare('DELETE FROM broker_request_replay WHERE expires_at <= ?').bind(now),
        this.db
          .prepare('INSERT INTO broker_request_replay (jti, expires_at, created_at) VALUES (?, ?, ?)')
          .bind(input.jti, input.expiresAt, now),
        this.db
          .prepare(
            "UPDATE github_connection_binding SET status = 'revoked', updated_at = ? WHERE broker_reference = ? AND owner_subject = ? AND status = 'active'",
          )
          .bind(now, input.brokerReference, input.ownerSubject),
        this.db.prepare('DELETE FROM github_connection_context WHERE broker_reference = ?').bind(input.brokerReference),
      ])
    } catch (error) {
      const replay = await this.db
        .prepare('SELECT jti FROM broker_request_replay WHERE jti = ?')
        .bind(input.jti)
        .first()
      if (replay) throw unauthorized('The Realmroot account revocation request was already used.')
      throw error
    }
  }

  private async contexts(brokerReference: string) {
    const result = await this.db
      .prepare(
        `SELECT installation_id AS installationId, account_login AS accountLogin, target_type AS targetType
         FROM github_connection_context WHERE broker_reference = ? ORDER BY installation_id`,
      )
      .bind(brokerReference)
      .all<{ installationId: number; accountLogin: string; targetType: string }>()
    return result.results
  }
}
