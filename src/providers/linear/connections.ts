import { z } from 'zod'
import type { BrokerRequestReplayStore } from '../../core/broker-request-replay.js'
import type { BrokeredConnectionRequest } from '../../core/connection-request.js'
import { sha256Base64Url } from '../../core/digest.js'
import { badRequest, forbidden, unauthorized } from '../../core/problem.js'
import { appAuthorizationScopes, parseLinearScopes } from './scopes.js'
import type { LinearCredentialCipher, LinearToken, LinearViewer } from './types.js'

const intentSchema = z.object({
  requestId: z.string(),
  connectionId: z.string(),
  expectedExternalSubject: z.string().nullable(),
  ownerSubject: z.string(),
  realmrootState: z.string(),
  callbackUri: z.url(),
  codeChallenge: z.string(),
  scopesJson: z.string(),
  linearUserId: z.string().nullable(),
  linearUserName: z.string().nullable(),
  status: z.enum(['pending_user', 'pending_app', 'completed', 'exchanged']),
  expiresAt: z.number().int(),
})

export type LinearConnectionIntent = z.infer<typeof intentSchema>
export type LinearWorkspaceCredential = Readonly<{
  brokerReference: string
  workspaceId: string
  workspaceName: string
  workspaceUrlKey: string
  appUserId: string
  accessToken: string
  refreshToken: string
  tokenExpiresAt: number
  scopes: readonly string[]
  credentialVersion: number
}>

export interface LinearConnectionStore {
  create(request: BrokeredConnectionRequest, providerState: string, now?: number): Promise<void>
  findByProviderState(providerState: string): Promise<LinearConnectionIntent>
  recordUser(intent: LinearConnectionIntent, viewer: LinearViewer, nextState: string): Promise<void>
  complete(intent: LinearConnectionIntent, viewer: LinearViewer, token: LinearToken, code: string): Promise<void>
  exchange(
    code: string,
    verifier: string,
    connectionRequestId: string,
  ): Promise<{
    brokerReference: string
    binding: { linearUserId: string; displayName: string; scopesJson: string }
    contexts: Array<{ workspaceId: string; workspaceName: string; workspaceUrlKey: string; appUserId: string }>
  }>
  credentialForOwner(ownerSubject: string, selectedWorkspaceId?: string): Promise<LinearWorkspaceCredential>
  claimRefresh(credential: LinearWorkspaceCredential, now?: number): Promise<boolean>
  replaceCredential(credential: LinearWorkspaceCredential, token: LinearToken, now?: number): Promise<boolean>
  releaseRefreshClaim(credential: LinearWorkspaceCredential): Promise<void>
  credentialsForRevocation(brokerReference: string, ownerSubject: string): Promise<LinearWorkspaceCredential[]>
  revoke(input: { brokerReference: string; ownerSubject: string; jti: string; expiresAt: number }): Promise<void>
  applyLifecycleWebhook(
    deliveryId: string,
    expiresAt: number,
    event:
      | {
          type: 'team-access-changed'
          workspaceId: string
          appUserId: string
          canAccessAllPublicTeams: boolean
          addedTeamIds: readonly string[]
          removedTeamIds: readonly string[]
        }
      | { type: 'revoked'; workspaceId: string },
    now?: number,
  ): Promise<void>
}

export class D1LinearConnections implements LinearConnectionStore {
  constructor(
    private readonly db: D1Database,
    private readonly cipher: LinearCredentialCipher,
    private readonly brokerRequestReplay: BrokerRequestReplayStore,
  ) {}

  async create(request: BrokeredConnectionRequest, providerState: string, now = Date.now()) {
    const scopes = appAuthorizationScopes(request.scope.split(/\s+/).filter(Boolean))
    const result = await this.db
      .prepare(
        `INSERT OR IGNORE INTO linear_connection_intent
          (request_id, connection_id, expected_external_subject, owner_subject, realmroot_state, callback_uri,
           code_challenge, scopes_json, provider_state_hash, status, expires_at, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending_user', ?, ?, ?)`,
      )
      .bind(
        request.jti,
        request.connection_id,
        request.expected_external_subject,
        request.sub,
        request.state,
        request.callback_uri,
        request.code_challenge,
        JSON.stringify(scopes),
        await sha256Base64Url(providerState),
        now + 10 * 60 * 1000,
        now,
        now,
      )
      .run()
    if (result.meta.changes !== 1) throw badRequest('The account connection request was already used.')
  }

  async findByProviderState(providerState: string) {
    const row = await this.db
      .prepare(
        `SELECT request_id AS requestId, connection_id AS connectionId,
                expected_external_subject AS expectedExternalSubject, owner_subject AS ownerSubject,
                realmroot_state AS realmrootState, callback_uri AS callbackUri, code_challenge AS codeChallenge,
                scopes_json AS scopesJson, linear_user_id AS linearUserId, linear_user_name AS linearUserName,
                status, expires_at AS expiresAt
         FROM linear_connection_intent WHERE provider_state_hash = ?`,
      )
      .bind(await sha256Base64Url(providerState))
      .first()
    if (!row) throw unauthorized('The Linear account connection state is invalid or expired.')
    const intent = intentSchema.parse(row)
    if (!['pending_user', 'pending_app'].includes(intent.status) || intent.expiresAt <= Date.now()) {
      throw unauthorized('The Linear account connection state is invalid or expired.')
    }
    return intent
  }

  async recordUser(intent: LinearConnectionIntent, viewer: LinearViewer, nextState: string) {
    if (intent.status !== 'pending_user') throw unauthorized('The Linear user authorization state is invalid.')
    if (intent.expectedExternalSubject !== null && intent.expectedExternalSubject !== viewer.user.id) {
      throw badRequest('Disconnect the current Linear account before connecting another account.')
    }
    const existing = await this.db
      .prepare(
        `SELECT linear_user_id AS linearUserId FROM linear_connection_binding
         WHERE owner_subject = ? AND status = 'active'`,
      )
      .bind(intent.ownerSubject)
      .first<{ linearUserId: string }>()
    if (existing && existing.linearUserId !== viewer.user.id) {
      throw badRequest('The active Linear account connection changed during authorization.')
    }
    const result = await this.db
      .prepare(
        `UPDATE linear_connection_intent
         SET provider_state_hash = ?, linear_user_id = ?, linear_user_name = ?, status = 'pending_app', updated_at = ?
         WHERE request_id = ? AND status = 'pending_user' AND expires_at > ?`,
      )
      .bind(
        await sha256Base64Url(nextState),
        viewer.user.id,
        viewer.user.name,
        Date.now(),
        intent.requestId,
        Date.now(),
      )
      .run()
    if (result.meta.changes !== 1) throw unauthorized('The Linear user authorization request expired.')
  }

  async complete(intent: LinearConnectionIntent, viewer: LinearViewer, token: LinearToken, code: string) {
    if (intent.status !== 'pending_app' || !intent.linearUserId || !intent.linearUserName) {
      throw unauthorized('The Linear App authorization state is invalid.')
    }
    const now = Date.now()
    const existing = await this.db
      .prepare(
        `SELECT broker_reference AS brokerReference, linear_user_id AS linearUserId
         FROM linear_connection_binding WHERE owner_subject = ? AND status = 'active'`,
      )
      .bind(intent.ownerSubject)
      .first<{ brokerReference: string; linearUserId: string }>()
    if (existing && existing.linearUserId !== intent.linearUserId) {
      throw badRequest('The active Linear account connection changed during authorization.')
    }
    const brokerReference = existing?.brokerReference ?? intent.connectionId
    const context = credentialContext(brokerReference, viewer.workspace.id)
    const [accessToken, refreshToken] = await Promise.all([
      this.cipher.seal(token.accessToken, `${context}:access`),
      this.cipher.seal(token.refreshToken, `${context}:refresh`),
    ])
    const scopesJson = JSON.stringify(token.scopes)
    const results = await this.db.batch([
      this.db
        .prepare(
          `INSERT INTO linear_connection_binding
            (broker_reference, owner_subject, linear_user_id, display_name, scopes_json, status, created_at, updated_at)
           VALUES (?, ?, ?, ?, ?, 'active', ?, ?)
           ON CONFLICT(broker_reference) DO UPDATE SET owner_subject = excluded.owner_subject,
             linear_user_id = excluded.linear_user_id, display_name = excluded.display_name,
             scopes_json = excluded.scopes_json, status = 'active', updated_at = excluded.updated_at`,
        )
        .bind(brokerReference, intent.ownerSubject, intent.linearUserId, intent.linearUserName, scopesJson, now, now),
      this.db
        .prepare(
          `INSERT INTO linear_connection_context
            (broker_reference, workspace_id, workspace_name, workspace_url_key, app_user_id,
             access_token_ciphertext, refresh_token_ciphertext, token_expires_at, scopes_json,
             status, credential_version, created_at, updated_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'active', 1, ?, ?)
           ON CONFLICT(broker_reference, workspace_id) DO UPDATE SET
             workspace_name = excluded.workspace_name, workspace_url_key = excluded.workspace_url_key,
             app_user_id = excluded.app_user_id, access_token_ciphertext = excluded.access_token_ciphertext,
             refresh_token_ciphertext = excluded.refresh_token_ciphertext,
             token_expires_at = excluded.token_expires_at, scopes_json = excluded.scopes_json,
             status = 'active', credential_version = linear_connection_context.credential_version + 1,
             refresh_claim_until = NULL, updated_at = excluded.updated_at`,
        )
        .bind(
          brokerReference,
          viewer.workspace.id,
          viewer.workspace.name,
          viewer.workspace.urlKey,
          viewer.user.id,
          accessToken,
          refreshToken,
          token.expiresAt,
          scopesJson,
          now,
          now,
        ),
      this.db
        .prepare(
          `UPDATE linear_connection_intent
           SET authorization_code_hash = ?, status = 'completed', updated_at = ?
           WHERE request_id = ? AND status = 'pending_app'`,
        )
        .bind(await sha256Base64Url(code), now, intent.requestId),
    ])
    if (results.at(-1)?.meta.changes !== 1) {
      throw unauthorized('The Linear account connection request was already used.')
    }
  }

  async exchange(code: string, verifier: string, connectionRequestId: string) {
    const row = await this.db
      .prepare(
        `SELECT request_id AS requestId, connection_id AS connectionId,
                expected_external_subject AS expectedExternalSubject, owner_subject AS ownerSubject,
                realmroot_state AS realmrootState, callback_uri AS callbackUri, code_challenge AS codeChallenge,
                scopes_json AS scopesJson, linear_user_id AS linearUserId, linear_user_name AS linearUserName,
                status, expires_at AS expiresAt
         FROM linear_connection_intent WHERE authorization_code_hash = ?`,
      )
      .bind(await sha256Base64Url(code))
      .first()
    if (!row) throw unauthorized('Connection code is invalid.')
    const intent = intentSchema.parse(row)
    if (intent.status !== 'completed' || intent.expiresAt <= Date.now())
      throw unauthorized('Connection code is invalid.')
    if (intent.requestId !== connectionRequestId) throw forbidden('Connection request binding is invalid.')
    if ((await sha256Base64Url(verifier)) !== intent.codeChallenge) throw forbidden('Connection PKCE proof is invalid.')
    const binding = await this.db
      .prepare(
        `SELECT broker_reference AS brokerReference, linear_user_id AS linearUserId,
                display_name AS displayName, scopes_json AS scopesJson
         FROM linear_connection_binding WHERE owner_subject = ? AND status = 'active'`,
      )
      .bind(intent.ownerSubject)
      .first<{ brokerReference: string; linearUserId: string; displayName: string; scopesJson: string }>()
    if (!binding) throw unauthorized('Linear account connection is unavailable.')
    const contexts = await this.contexts(binding.brokerReference)
    const consumed = await this.db
      .prepare(
        "UPDATE linear_connection_intent SET status = 'exchanged', updated_at = ? WHERE request_id = ? AND status = 'completed'",
      )
      .bind(Date.now(), intent.requestId)
      .run()
    if (consumed.meta.changes !== 1) throw unauthorized('Connection code was already used.')
    return { brokerReference: binding.brokerReference, binding, contexts }
  }

  async credentialForOwner(ownerSubject: string, selectedWorkspaceId?: string) {
    const binding = await this.db
      .prepare(
        "SELECT broker_reference AS brokerReference FROM linear_connection_binding WHERE owner_subject = ? AND status = 'active'",
      )
      .bind(ownerSubject)
      .first<{ brokerReference: string }>()
    if (!binding) throw forbidden('Active Linear account connection is required.')
    const rows = await this.credentialRows(binding.brokerReference)
    const selected = selectedWorkspaceId
      ? rows.find((context) => context.workspaceId === selectedWorkspaceId)
      : rows.length === 1
        ? rows[0]
        : undefined
    if (!selected) throw forbidden('Select exactly one connected Linear workspace for this request.')
    return this.decryptCredential(selected)
  }

  async claimRefresh(credential: LinearWorkspaceCredential, now = Date.now()) {
    const result = await this.db
      .prepare(
        `UPDATE linear_connection_context SET refresh_claim_until = ?, updated_at = ?
         WHERE broker_reference = ? AND workspace_id = ? AND status = 'active' AND credential_version = ?
           AND (refresh_claim_until IS NULL OR refresh_claim_until <= ?)`,
      )
      .bind(now + 15_000, now, credential.brokerReference, credential.workspaceId, credential.credentialVersion, now)
      .run()
    return result.meta.changes === 1
  }

  async replaceCredential(credential: LinearWorkspaceCredential, token: LinearToken, now = Date.now()) {
    const context = credentialContext(credential.brokerReference, credential.workspaceId)
    const [accessToken, refreshToken] = await Promise.all([
      this.cipher.seal(token.accessToken, `${context}:access`),
      this.cipher.seal(token.refreshToken, `${context}:refresh`),
    ])
    const result = await this.db
      .prepare(
        `UPDATE linear_connection_context
         SET access_token_ciphertext = ?, refresh_token_ciphertext = ?, token_expires_at = ?, scopes_json = ?,
             credential_version = credential_version + 1, refresh_claim_until = NULL, updated_at = ?
         WHERE broker_reference = ? AND workspace_id = ? AND status = 'active' AND credential_version = ?`,
      )
      .bind(
        accessToken,
        refreshToken,
        token.expiresAt,
        JSON.stringify(token.scopes),
        now,
        credential.brokerReference,
        credential.workspaceId,
        credential.credentialVersion,
      )
      .run()
    return result.meta.changes === 1
  }

  async releaseRefreshClaim(credential: LinearWorkspaceCredential) {
    await this.db
      .prepare(
        `UPDATE linear_connection_context SET refresh_claim_until = NULL, updated_at = ?
         WHERE broker_reference = ? AND workspace_id = ? AND credential_version = ?`,
      )
      .bind(Date.now(), credential.brokerReference, credential.workspaceId, credential.credentialVersion)
      .run()
  }

  async credentialsForRevocation(brokerReference: string, ownerSubject: string) {
    const binding = await this.db
      .prepare('SELECT status FROM linear_connection_binding WHERE broker_reference = ? AND owner_subject = ?')
      .bind(brokerReference, ownerSubject)
      .first<{ status: 'active' | 'revoked' }>()
    if (!binding) throw forbidden('The brokered Linear account connection was not found.')
    return Promise.all((await this.credentialRows(brokerReference)).map((row) => this.decryptCredential(row)))
  }

  async revoke(input: { brokerReference: string; ownerSubject: string; jti: string; expiresAt: number }) {
    const now = Date.now()
    try {
      await this.db.batch([
        ...this.brokerRequestReplay.brokerRequestReplayStatements({
          jti: input.jti,
          expiresAt: input.expiresAt,
          now,
        }),
        this.db
          .prepare(
            `UPDATE linear_connection_binding SET status = 'revoked', updated_at = ?
             WHERE broker_reference = ? AND owner_subject = ? AND status = 'active'`,
          )
          .bind(now, input.brokerReference, input.ownerSubject),
        this.db
          .prepare(
            `UPDATE linear_connection_context SET status = 'revoked', access_token_ciphertext = '',
               refresh_token_ciphertext = '', refresh_claim_until = NULL, updated_at = ?
             WHERE broker_reference = ? AND status = 'active'`,
          )
          .bind(now, input.brokerReference),
      ])
    } catch (error) {
      if (await this.brokerRequestReplay.hasBrokerRequest(input.jti)) {
        throw unauthorized('The Realmroot account revocation request was already used.')
      }
      throw error
    }
  }

  async applyLifecycleWebhook(
    deliveryId: string,
    expiresAt: number,
    event:
      | {
          type: 'team-access-changed'
          workspaceId: string
          appUserId: string
          canAccessAllPublicTeams: boolean
          addedTeamIds: readonly string[]
          removedTeamIds: readonly string[]
        }
      | { type: 'revoked'; workspaceId: string },
    now = Date.now(),
  ) {
    const statements = [
      this.db.prepare('DELETE FROM linear_webhook_delivery WHERE expires_at <= ?').bind(now),
      this.db
        .prepare('INSERT INTO linear_webhook_delivery (delivery_id, expires_at, created_at) VALUES (?, ?, ?)')
        .bind(deliveryId, expiresAt, now),
    ]
    if (event.type === 'revoked') {
      const context = await this.db
        .prepare(
          `SELECT workspace_id FROM linear_connection_context
           WHERE workspace_id = ? AND status = 'active'`,
        )
        .bind(event.workspaceId)
        .first()
      if (!context) throw forbidden('The Linear webhook workspace is not connected.')
      statements.push(
        this.db
          .prepare(
            `UPDATE linear_connection_context SET status = 'revoked', access_token_ciphertext = '',
               refresh_token_ciphertext = '', refresh_claim_until = NULL, updated_at = ?
             WHERE workspace_id = ? AND status = 'active'`,
          )
          .bind(now, event.workspaceId),
      )
    } else {
      const row = await this.db
        .prepare(
          `SELECT team_ids_json AS teamIdsJson FROM linear_connection_context
           WHERE workspace_id = ? AND app_user_id = ? AND status = 'active'`,
        )
        .bind(event.workspaceId, event.appUserId)
        .first<{ teamIdsJson: string }>()
      if (!row) throw forbidden('The Linear webhook workspace is not connected.')
      const teams = new Set(z.array(z.string()).parse(JSON.parse(row.teamIdsJson)))
      for (const id of event.removedTeamIds) teams.delete(id)
      for (const id of event.addedTeamIds) teams.add(id)
      statements.push(
        this.db
          .prepare(
            `UPDATE linear_connection_context
             SET can_access_all_public_teams = ?, team_ids_json = ?, updated_at = ?
             WHERE workspace_id = ? AND app_user_id = ? AND status = 'active'`,
          )
          .bind(
            event.canAccessAllPublicTeams ? 1 : 0,
            JSON.stringify([...teams].sort()),
            now,
            event.workspaceId,
            event.appUserId,
          ),
      )
    }
    try {
      const results = await this.db.batch(statements)
      if (results.at(-1)?.meta.changes !== 1) throw forbidden('The Linear webhook workspace is not connected.')
    } catch (error) {
      const replay = await this.db
        .prepare('SELECT delivery_id FROM linear_webhook_delivery WHERE delivery_id = ?')
        .bind(deliveryId)
        .first()
      if (replay) throw unauthorized('The Linear webhook delivery was already processed.')
      throw error
    }
  }

  private async contexts(brokerReference: string) {
    const result = await this.db
      .prepare(
        `SELECT workspace_id AS workspaceId, workspace_name AS workspaceName,
                workspace_url_key AS workspaceUrlKey, app_user_id AS appUserId
         FROM linear_connection_context WHERE broker_reference = ? AND status = 'active' ORDER BY workspace_name`,
      )
      .bind(brokerReference)
      .all<{ workspaceId: string; workspaceName: string; workspaceUrlKey: string; appUserId: string }>()
    return result.results
  }

  private async credentialRows(brokerReference: string) {
    const result = await this.db
      .prepare(
        `SELECT broker_reference AS brokerReference, workspace_id AS workspaceId,
                workspace_name AS workspaceName, workspace_url_key AS workspaceUrlKey, app_user_id AS appUserId,
                access_token_ciphertext AS accessTokenCiphertext,
                refresh_token_ciphertext AS refreshTokenCiphertext, token_expires_at AS tokenExpiresAt,
                scopes_json AS scopesJson, credential_version AS credentialVersion
         FROM linear_connection_context WHERE broker_reference = ? AND status = 'active' ORDER BY workspace_name`,
      )
      .bind(brokerReference)
      .all<CredentialRow>()
    return result.results
  }

  private async decryptCredential(row: CredentialRow): Promise<LinearWorkspaceCredential> {
    const context = credentialContext(row.brokerReference, row.workspaceId)
    const [accessToken, refreshToken] = await Promise.all([
      this.cipher.open(row.accessTokenCiphertext, `${context}:access`),
      this.cipher.open(row.refreshTokenCiphertext, `${context}:refresh`),
    ])
    return {
      brokerReference: row.brokerReference,
      workspaceId: row.workspaceId,
      workspaceName: row.workspaceName,
      workspaceUrlKey: row.workspaceUrlKey,
      appUserId: row.appUserId,
      accessToken,
      refreshToken,
      tokenExpiresAt: row.tokenExpiresAt,
      scopes: parseLinearScopes(JSON.parse(row.scopesJson) as string[]),
      credentialVersion: row.credentialVersion,
    }
  }
}

type CredentialRow = {
  brokerReference: string
  workspaceId: string
  workspaceName: string
  workspaceUrlKey: string
  appUserId: string
  accessTokenCiphertext: string
  refreshTokenCiphertext: string
  tokenExpiresAt: number
  scopesJson: string
  credentialVersion: number
}

function credentialContext(brokerReference: string, workspaceId: string) {
  return `linear:${brokerReference}:${workspaceId}`
}
