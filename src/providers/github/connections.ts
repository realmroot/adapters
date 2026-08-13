import { z } from 'zod'
import type { BrokerRequestReplayStore } from '../../core/broker-request-replay.js'
import type { BrokeredConnectionRequest } from '../../core/connection-request.js'
import { sha256Base64Url } from '../../core/digest.js'
import { badRequest, forbidden, HttpProblem, unauthorized } from '../../core/problem.js'
import { mergePermissions, permissionsToScopes } from './permissions.js'
import type { GitHubInstallation, GitHubUser } from './types.js'

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
    contexts: GitHubAuthorizationContext[]
  }>
  activeInstallationsForOwner(ownerSubject: string, brokerReference: string): Promise<GitHubAuthorizationContext[]>
  activeInstallationsForReference(brokerReference: string): Promise<GitHubAuthorizationContext[]>
  externalAuthorization(githubUserId: string): Promise<{
    displayName: string
    scopes: string[]
    contexts: GitHubAuthorizationContext[]
  }>
  revoke(input: { brokerReference: string; ownerSubject: string; jti: string; expiresAt: number }): Promise<void>
  prepareLifecycleEvent(input: GitHubLifecycleChange): Promise<{ event: GitHubLifecycleEvent | null; completed: boolean }>
  pendingLifecycleEvents(): Promise<GitHubLifecycleEvent[]>
  completeLifecycleEvent(deliveryId: string): Promise<void>
}

export type GitHubLifecycleChange = Readonly<{
  deliveryId: string
  fingerprint: string
  type: 'deleted' | 'suspended' | 'restored' | 'resourcesChanged' | 'authorityChanged'
  installationId: number
  occurredAt: string
  providerUpdatedAt: number
  scopes?: readonly string[]
  repositorySelection?: 'all' | 'selected'
  repositoriesAdded?: readonly GitHubRepositoryChange[]
  repositoriesRemoved?: readonly GitHubRepositoryChange[]
}>

type GitHubLifecycleEventCommon = Readonly<{
  id: string
  brokerReference: string
  occurredAt: string
  revision: number
}>

type GitHubLifecycleEvent = GitHubLifecycleEventCommon &
  (
    | Readonly<{
        type: 'authorityChanged'
        scopes: readonly string[]
        affectedScopes: readonly string[]
        affectedAuthorizationDetails: readonly Record<string, unknown>[]
        authorityConstraints: readonly {
          authorizationDetails: readonly Record<string, unknown>[]
          scopes: readonly string[]
        }[]
      }>
    | Readonly<{
        type: 'resourcesChanged' | 'restored'
        scopes: readonly string[]
        authorizationDetails: readonly Record<string, unknown>[]
        authorityConstraints: readonly {
          authorizationDetails: readonly Record<string, unknown>[]
          scopes: readonly string[]
        }[]
      }>
    | Readonly<{ type: 'suspended' | 'revoked' }>
  )

export type GitHubRepositoryChange = Readonly<{ id: number; fullName: string }>
export type GitHubAuthorizationContext = Readonly<{
  installationId: number
  accountLogin: string
  targetType: string
  scopes: readonly string[]
  repositorySelection: 'all' | 'selected'
  repositories: readonly GitHubRepositoryChange[]
}>

export class D1GitHubConnections implements GitHubConnectionStore {
  constructor(
    private readonly db: D1Database,
    private readonly brokerRequestReplay: BrokerRequestReplayStore,
  ) {}

  async upsertExternalAuthorization(user: GitHubUser, installations: GitHubInstallation[]) {
    const now = Date.now()
    const existing = await this.db
      .prepare(
        `SELECT broker_reference AS brokerReference
         FROM github_connection_binding
         WHERE github_user_id = ? AND status = 'active'
         ORDER BY updated_at DESC LIMIT 1`,
      )
      .bind(user.id)
      .first<{ brokerReference: string }>()
    const brokerReference = existing?.brokerReference ?? `github:${user.id}`
    if (installations.length > 0) {
      const placeholders = installations.map(() => '?').join(', ')
      const occupied = await this.db
        .prepare(
          `SELECT broker_reference AS brokerReference
           FROM github_connection_context
           WHERE installation_id IN (${placeholders}) AND broker_reference <> ?
           LIMIT 1`,
        )
        .bind(...installations.map((installation) => installation.id), brokerReference)
        .first<{ brokerReference: string }>()
      if (occupied) throw forbidden('The selected GitHub installation is already connected to another account.')
    }
    const grantedScopes = permissionsToScopes(
      mergePermissions(installations.map((installation) => installation.permissions)),
    )
    const statements: D1PreparedStatement[] = [
      this.db
        .prepare(
          `INSERT INTO github_connection_binding
            (broker_reference, owner_subject, github_user_id, github_login, display_name, scopes_json, status, created_at, updated_at)
           VALUES (?, ?, ?, ?, ?, ?, 'active', ?, ?)
           ON CONFLICT(broker_reference) DO UPDATE SET owner_subject = excluded.owner_subject,
             github_user_id = excluded.github_user_id, github_login = excluded.github_login,
             display_name = excluded.display_name, scopes_json = excluded.scopes_json,
             status = 'active', updated_at = excluded.updated_at`,
        )
        .bind(
          brokerReference,
          String(user.id),
          user.id,
          user.login,
          user.name ?? user.login,
          JSON.stringify(grantedScopes),
          now,
          now,
        ),
      this.db.prepare('DELETE FROM github_connection_context WHERE broker_reference = ?').bind(brokerReference),
      ...installations.map((installation) =>
        this.db
          .prepare(
            `INSERT INTO github_connection_context
              (broker_reference, installation_id, account_login, target_type, created_at,
               status, scopes_json, updated_at, repository_selection)
             VALUES (?, ?, ?, ?, ?, 'active', ?, ?, ?)`,
          )
          .bind(
            brokerReference,
            installation.id,
            installation.accountLogin,
            installation.targetType,
            now,
            JSON.stringify(permissionsToScopes(installation.permissions)),
            now,
            installation.repositorySelection,
          ),
      ),
      ...installations.flatMap((installation) =>
        installation.repositories.map((repository) =>
          this.db
            .prepare(
              `INSERT INTO github_connection_repository (installation_id, repository_id, full_name, updated_at)
               VALUES (?, ?, ?, ?) ON CONFLICT(installation_id, repository_id) DO UPDATE SET
                 full_name = excluded.full_name, updated_at = excluded.updated_at`,
            )
            .bind(installation.id, repository.id, repository.fullName, now),
        ),
      ),
    ]
    await this.db.batch(statements)
    return this.activeInstallationsForReference(brokerReference)
  }

  async revokeExternalAuthorization(githubUserId: string) {
    const binding = await this.db
      .prepare(
        `SELECT broker_reference AS brokerReference FROM github_connection_binding
         WHERE owner_subject = ? AND status = 'active'`,
      )
      .bind(githubUserId)
      .first<{ brokerReference: string }>()
    if (!binding) return
    await this.db.batch([
      this.db
        .prepare(
          `UPDATE github_connection_binding SET status = 'revoked', updated_at = ?
           WHERE broker_reference = ? AND status = 'active'`,
        )
        .bind(Date.now(), binding.brokerReference),
      this.db.prepare('DELETE FROM github_connection_context WHERE broker_reference = ?').bind(binding.brokerReference),
    ])
  }

  async externalAuthorization(githubUserId: string) {
    const binding = await this.db
      .prepare(
        `SELECT broker_reference AS brokerReference, display_name AS displayName, scopes_json AS scopesJson
         FROM github_connection_binding
         WHERE github_user_id = ? AND owner_subject = ? AND status = 'active'`,
      )
      .bind(Number(githubUserId), githubUserId)
      .first<{ brokerReference: string; displayName: string; scopesJson: string }>()
    if (!binding) throw forbidden('Active GitHub authorization is required.')
    return {
      displayName: binding.displayName,
      scopes: JSON.parse(binding.scopesJson) as string[],
      contexts: await this.activeInstallationsForReference(binding.brokerReference),
    }
  }

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
    const grantedScopes = permissionsToScopes(
      mergePermissions(installations.map((installation) => installation.permissions)),
    )
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
          JSON.stringify(grantedScopes),
          now,
          now,
        ),
      this.db.prepare('DELETE FROM github_connection_context WHERE broker_reference = ?').bind(brokerReference),
      ...installations.map((installation) =>
        this.db
          .prepare(
            `INSERT INTO github_connection_context
              (broker_reference, installation_id, account_login, target_type, created_at, status, scopes_json, updated_at, repository_selection)
             VALUES (?, ?, ?, ?, ?, 'active', ?, ?, ?)`,
          )
          .bind(
            brokerReference,
            installation.id,
            installation.accountLogin,
            installation.targetType,
            now,
            JSON.stringify(permissionsToScopes(installation.permissions)),
            now,
            installation.repositorySelection,
          ),
      ),
      ...installations.flatMap((installation) =>
        installation.repositories.map((repository) =>
          this.db
            .prepare(
              `INSERT INTO github_connection_repository (installation_id, repository_id, full_name, updated_at)
               VALUES (?, ?, ?, ?)`,
            )
            .bind(installation.id, repository.id, repository.fullName, now),
        ),
      ),
      ...installations.map((installation) =>
        this.db
          .prepare(
            `INSERT INTO github_installation_lifecycle_cursor
              (installation_id, provider_updated_at, delivery_id, updated_at)
             VALUES (?, ?, '', ?)
             ON CONFLICT(installation_id) DO UPDATE SET
               provider_updated_at = excluded.provider_updated_at,
               delivery_id = excluded.delivery_id,
               updated_at = excluded.updated_at`,
          )
          .bind(installation.id, Date.parse(installation.updatedAt), now),
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

  async activeInstallationsForOwner(ownerSubject: string, brokerReference: string) {
    const binding = await this.db
      .prepare(
        `SELECT broker_reference AS brokerReference FROM github_connection_binding
         WHERE owner_subject = ? AND broker_reference = ? AND status = 'active'`,
      )
      .bind(ownerSubject, brokerReference)
      .first<{ brokerReference: string }>()
    if (!binding) throw forbidden('Active GitHub account connection is required.')
    return this.contexts(binding.brokerReference)
  }

  async activeInstallationsForReference(brokerReference: string) {
    const binding = await this.db
      .prepare(
        `SELECT broker_reference AS brokerReference FROM github_connection_binding
         WHERE broker_reference = ? AND status = 'active'`,
      )
      .bind(brokerReference)
      .first<{ brokerReference: string }>()
    if (!binding) throw forbidden('Active GitHub account connection is required.')
    return this.contexts(binding.brokerReference)
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
        ...this.brokerRequestReplay.brokerRequestReplayStatements({
          jti: input.jti,
          expiresAt: input.expiresAt,
          now,
        }),
        this.db
          .prepare(
            "UPDATE github_connection_binding SET status = 'revoked', updated_at = ? WHERE broker_reference = ? AND owner_subject = ? AND status = 'active'",
          )
          .bind(now, input.brokerReference, input.ownerSubject),
        this.db.prepare('DELETE FROM github_connection_context WHERE broker_reference = ?').bind(input.brokerReference),
      ])
    } catch (error) {
      if (await this.brokerRequestReplay.hasBrokerRequest(input.jti)) {
        throw unauthorized('The Realmroot account revocation request was already used.')
      }
      throw error
    }
  }

  async prepareLifecycleEvent(
    input: GitHubLifecycleChange,
  ): Promise<{ event: GitHubLifecycleEvent | null; completed: boolean }> {
    const delivery = await this.db
      .prepare('SELECT fingerprint, event_json AS eventJson, state FROM github_webhook_delivery WHERE delivery_id = ?')
      .bind(input.deliveryId)
      .first<{ fingerprint: string; eventJson: string; state: 'pending' | 'completed' }>()
    if (delivery) {
      if (delivery.fingerprint !== input.fingerprint) throw webhookDeliveryConflict()
      return {
        event: JSON.parse(delivery.eventJson) as GitHubLifecycleEvent | null,
        completed: delivery.state === 'completed',
      }
    }

    const selected = await this.db
      .prepare(
        `SELECT context.broker_reference AS brokerReference, context.installation_id AS installationId,
                context.account_login AS accountLogin, context.target_type AS targetType, context.status,
                context.scopes_json AS scopesJson, context.repository_selection AS repositorySelection,
                binding.event_revision AS eventRevision
         FROM github_connection_context AS context
         INNER JOIN github_connection_binding AS binding
           ON binding.broker_reference = context.broker_reference
         WHERE context.installation_id = ?`,
      )
      .bind(input.installationId)
      .first<LifecycleContext & { eventRevision: number }>()
    if (!selected) {
      await this.recordCompletedLifecycleDelivery(input)
      return { event: null, completed: true }
    }

    const cursor = await this.db
      .prepare(
        `SELECT provider_updated_at AS providerUpdatedAt,
                deletion_terminal AS deletionTerminal,
                restrictive_suspension AS restrictiveSuspension,
                restrictive_selection AS restrictiveSelection
         FROM github_installation_lifecycle_cursor WHERE installation_id = ?`,
      )
      .bind(input.installationId)
      .first<LifecycleCursor>()
    if (
      cursor?.deletionTerminal === 1 ||
      (cursor && input.providerUpdatedAt < cursor.providerUpdatedAt) ||
      (cursor?.providerUpdatedAt === input.providerUpdatedAt &&
        cursor.restrictiveSuspension === 1 &&
        input.type === 'restored')
    ) {
      await this.recordCompletedLifecycleDelivery(input)
      return { event: null, completed: true }
    }

    const contexts = await this.lifecycleContexts(selected.brokerReference)
    const sameTimestamp = cursor?.providerUpdatedAt === input.providerUpdatedAt
    const repositoryCursors =
      input.type === 'resourcesChanged'
        ? await this.repositoryLifecycleCursors(input.installationId, [
            ...(input.repositoriesAdded ?? []),
            ...(input.repositoriesRemoved ?? []),
          ])
        : new Map<number, RepositoryLifecycleCursor>()
    const repositoryChanges = effectiveRepositoryChanges(input, repositoryCursors)
    const nextContexts = contexts.flatMap((context) => {
      if (context.installationId !== input.installationId) return [context]
      if (input.type === 'deleted') return []
      const repositorySelection =
        sameTimestamp && cursor?.restrictiveSelection === 1
          ? 'selected'
          : (input.repositorySelection ?? context.repositorySelection)
      return [
        {
          ...context,
          status:
            input.type === 'suspended'
              ? ('suspended' as const)
              : input.type === 'restored'
                ? ('active' as const)
                : context.status,
          scopesJson: input.scopes
            ? JSON.stringify(
                sameTimestamp
                  ? intersectScopes(JSON.parse(context.scopesJson) as string[], input.scopes)
                  : input.scopes,
              )
            : context.scopesJson,
          repositorySelection,
          repositories: nextRepositories(context.repositories, repositoryChanges, repositorySelection),
        },
      ]
    })
    const activeContexts = nextContexts.filter((context) => context.status === 'active')
    const scopes = [...new Set(activeContexts.flatMap((context) => JSON.parse(context.scopesJson) as string[]))].sort()
    const authorizationDetails = activeContexts.map(contextAuthorizationDetail)
    const authorityConstraints = activeContexts.map((context) => ({
      authorizationDetails: [contextAuthorizationDetail(context)],
      scopes: JSON.parse(context.scopesJson) as string[],
    }))
    const eventType = lifecycleEventType(input.type, contexts, activeContexts)
    const nextSelected = nextContexts.find(matchesInstallation(input))
    if (input.type !== 'deleted' && !nextSelected)
      throw new Error('The changed GitHub installation context is missing.')
    const commonEvent = {
      id: input.deliveryId,
      brokerReference: selected.brokerReference,
      occurredAt: input.occurredAt,
      revision: selected.eventRevision + 1,
    }
    let event: GitHubLifecycleEvent
    if (eventType === 'authorityChanged') {
      if (!nextSelected) throw new Error('The changed GitHub installation context is missing.')
      event = {
        ...commonEvent,
        type: eventType,
        scopes,
        affectedScopes: JSON.parse(nextSelected.scopesJson) as string[],
        affectedAuthorizationDetails: [contextAuthorizationDetail(nextSelected)],
        authorityConstraints,
      }
    } else if (eventType === 'resourcesChanged' || eventType === 'restored') {
      event = { ...commonEvent, type: eventType, scopes, authorizationDetails, authorityConstraints }
    } else {
      event = { ...commonEvent, type: eventType }
    }
    const now = Date.now()
    const revision = event.revision
    const claimMatches = `EXISTS (
      SELECT 1 FROM github_connection_binding
      WHERE broker_reference = ? AND event_revision = ? AND lifecycle_claim = ?
    )`
    const cursorMatches = `EXISTS (
      SELECT 1 FROM github_installation_lifecycle_cursor
      WHERE installation_id = ? AND provider_updated_at = ? AND deletion_terminal = 0
    ) AND ${claimMatches}`
    const deletionCursorMatches = `EXISTS (
      SELECT 1 FROM github_installation_lifecycle_cursor
      WHERE installation_id = ? AND provider_updated_at = ? AND deletion_terminal = 1
    ) AND ${claimMatches}`
    const acceptedCursorMatches = input.type === 'deleted' ? deletionCursorMatches : cursorMatches
    const nextDeletionTerminal = input.type === 'deleted' ? 1 : 0
    const nextRestrictiveSuspension = input.type === 'suspended' ? 1 : 0
    const nextRestrictiveSelection = input.repositorySelection === 'selected' ? 1 : 0
    const statements: D1PreparedStatement[] = [
      this.db
        .prepare(
          `UPDATE github_connection_binding
           SET event_revision = ?, lifecycle_claim = ?
           WHERE broker_reference = ? AND event_revision = ? AND lifecycle_claim IS NULL`,
        )
        .bind(revision, input.deliveryId, selected.brokerReference, selected.eventRevision),
      this.db
        .prepare(
          `INSERT INTO github_installation_lifecycle_cursor
            (installation_id, provider_updated_at, delivery_id, deletion_terminal,
             restrictive_suspension, restrictive_selection, updated_at)
           SELECT ?, ?, ?, ?, ?, ?, ? WHERE ${claimMatches}
           ON CONFLICT(installation_id) DO UPDATE SET
             provider_updated_at = excluded.provider_updated_at,
             delivery_id = excluded.delivery_id,
             deletion_terminal = CASE
               WHEN excluded.provider_updated_at > provider_updated_at THEN excluded.deletion_terminal
               ELSE MAX(deletion_terminal, excluded.deletion_terminal)
             END,
             restrictive_suspension = CASE
               WHEN excluded.provider_updated_at > provider_updated_at THEN excluded.restrictive_suspension
               ELSE MAX(restrictive_suspension, excluded.restrictive_suspension)
             END,
             restrictive_selection = CASE
               WHEN excluded.provider_updated_at > provider_updated_at THEN excluded.restrictive_selection
               ELSE MAX(restrictive_selection, excluded.restrictive_selection)
             END,
             updated_at = excluded.updated_at
           WHERE deletion_terminal = 0 AND excluded.provider_updated_at >= provider_updated_at`,
        )
        .bind(
          input.installationId,
          input.providerUpdatedAt,
          input.deliveryId,
          nextDeletionTerminal,
          nextRestrictiveSuspension,
          nextRestrictiveSelection,
          now,
          selected.brokerReference,
          revision,
          input.deliveryId,
        ),
    ]
    if (input.type === 'deleted') {
      statements.push(
        this.db
          .prepare(`DELETE FROM github_connection_context WHERE installation_id = ? AND ${deletionCursorMatches}`)
          .bind(
            input.installationId,
            input.installationId,
            input.providerUpdatedAt,
            selected.brokerReference,
            revision,
            input.deliveryId,
          ),
      )
    } else {
      if (!nextSelected) throw new Error('The changed GitHub installation context is missing.')
      statements.push(
        this.db
          .prepare(
            `UPDATE github_connection_context
             SET status = ?, scopes_json = ?, repository_selection = ?, updated_at = ?
             WHERE installation_id = ? AND ${cursorMatches}`,
          )
          .bind(
            nextSelected.status,
            nextSelected.scopesJson,
            nextSelected.repositorySelection,
            now,
            input.installationId,
            input.installationId,
            input.providerUpdatedAt,
            selected.brokerReference,
            revision,
            input.deliveryId,
          ),
      )
      if (input.type === 'resourcesChanged') {
        for (const repository of repositoryChanges.removed) {
          statements.push(
            repositoryLifecycleCursorStatement(
              this.db,
              input,
              repository,
              true,
              now,
              selected.brokerReference,
              revision,
            ),
          )
        }
        for (const repository of repositoryChanges.added) {
          statements.push(
            repositoryLifecycleCursorStatement(
              this.db,
              input,
              repository,
              false,
              now,
              selected.brokerReference,
              revision,
            ),
          )
        }
        if (nextSelected.repositorySelection === 'all') {
          statements.push(
            this.db
              .prepare(`DELETE FROM github_connection_repository WHERE installation_id = ? AND ${cursorMatches}`)
              .bind(
                input.installationId,
                input.installationId,
                input.providerUpdatedAt,
                selected.brokerReference,
                revision,
                input.deliveryId,
              ),
          )
        } else {
          const repositoryCursorMatches = `EXISTS (
            SELECT 1 FROM github_repository_lifecycle_cursor
            WHERE installation_id = ? AND repository_id = ? AND provider_updated_at = ? AND removed = ?
          ) AND ${claimMatches}`
          for (const repository of repositoryChanges.removed) {
            statements.push(
              this.db
                .prepare(
                  `DELETE FROM github_connection_repository
                   WHERE installation_id = ? AND repository_id = ? AND ${repositoryCursorMatches}`,
                )
                .bind(
                  input.installationId,
                  repository.id,
                  input.installationId,
                  repository.id,
                  input.providerUpdatedAt,
                  1,
                  selected.brokerReference,
                  revision,
                  input.deliveryId,
                ),
            )
          }
          for (const repository of repositoryChanges.added) {
            statements.push(
              this.db
                .prepare(
                  `INSERT INTO github_connection_repository (installation_id, repository_id, full_name, updated_at)
                   SELECT ?, ?, ?, ? WHERE ${repositoryCursorMatches}
                   ON CONFLICT(installation_id, repository_id) DO UPDATE SET
                     full_name = excluded.full_name, updated_at = excluded.updated_at`,
                )
                .bind(
                  input.installationId,
                  repository.id,
                  repository.fullName,
                  now,
                  input.installationId,
                  repository.id,
                  input.providerUpdatedAt,
                  0,
                  selected.brokerReference,
                  revision,
                  input.deliveryId,
                ),
            )
          }
        }
      }
    }
    statements.push(
      this.db
        .prepare(
          `INSERT INTO github_webhook_delivery (delivery_id, fingerprint, event_json, state, created_at, updated_at)
           SELECT ?, ?, ?, 'pending', ?, ? WHERE ${acceptedCursorMatches}`,
        )
        .bind(
          input.deliveryId,
          input.fingerprint,
          JSON.stringify(event),
          now,
          now,
          input.installationId,
          input.providerUpdatedAt,
          selected.brokerReference,
          revision,
          input.deliveryId,
        ),
      this.db
        .prepare(
          `UPDATE github_connection_binding
           SET status = ?, scopes_json = ?, updated_at = ?, lifecycle_claim = NULL
           WHERE broker_reference = ? AND event_revision = ? AND lifecycle_claim = ?`,
        )
        .bind(
          activeContexts.length === 0 ? 'revoked' : 'active',
          JSON.stringify(scopes),
          now,
          selected.brokerReference,
          revision,
          input.deliveryId,
        ),
    )
    const results = await this.db.batch(statements)
    if (results[0]?.meta.changes !== 1) return this.prepareLifecycleEvent(input)
    const pending = results.at(-2)?.meta.changes === 1
    if (pending) return { event, completed: false }
    return this.prepareLifecycleEvent(input)
  }

  private async recordCompletedLifecycleDelivery(input: GitHubLifecycleChange) {
    const now = Date.now()
    await this.db
      .prepare(
        `INSERT OR IGNORE INTO github_webhook_delivery (delivery_id, fingerprint, event_json, state, created_at, updated_at)
         VALUES (?, ?, 'null', 'completed', ?, ?)`,
      )
      .bind(input.deliveryId, input.fingerprint, now, now)
      .run()
    const claimed = await this.db
      .prepare('SELECT fingerprint FROM github_webhook_delivery WHERE delivery_id = ?')
      .bind(input.deliveryId)
      .first<{ fingerprint: string }>()
    if (claimed?.fingerprint !== input.fingerprint) throw webhookDeliveryConflict()
  }

  async completeLifecycleEvent(deliveryId: string) {
    const result = await this.db
      .prepare(
        "UPDATE github_webhook_delivery SET state = 'completed', updated_at = ? WHERE delivery_id = ? AND state = 'pending'",
      )
      .bind(Date.now(), deliveryId)
      .run()
    if (result.meta.changes === 1) return
    const delivery = await this.db
      .prepare('SELECT state FROM github_webhook_delivery WHERE delivery_id = ?')
      .bind(deliveryId)
      .first<{ state: 'pending' | 'completed' }>()
    if (delivery?.state !== 'completed') throw new Error('The GitHub webhook delivery is not pending.')
  }

  async pendingLifecycleEvents() {
    const result = await this.db
      .prepare(
        "SELECT event_json AS eventJson FROM github_webhook_delivery WHERE state = 'pending' ORDER BY created_at",
      )
      .all<{ eventJson: string }>()
    return result.results.map(({ eventJson }) => JSON.parse(eventJson) as GitHubLifecycleEvent)
  }

  private async contexts(brokerReference: string) {
    return (await this.lifecycleContexts(brokerReference))
      .filter((context) => context.status === 'active')
      .map(({ brokerReference: _, status: __, scopesJson, ...context }) => ({
        ...context,
        scopes: JSON.parse(scopesJson) as string[],
      }))
  }

  private async lifecycleContexts(brokerReference: string) {
    const [contextResult, repositoryResult] = await Promise.all([
      this.db
        .prepare(
          `SELECT broker_reference AS brokerReference, installation_id AS installationId,
                  account_login AS accountLogin, target_type AS targetType, status, scopes_json AS scopesJson,
                  repository_selection AS repositorySelection
           FROM github_connection_context WHERE broker_reference = ? ORDER BY installation_id`,
        )
        .bind(brokerReference)
        .all<Omit<LifecycleContext, 'repositories'>>(),
      this.db
        .prepare(
          `SELECT repository.installation_id AS installationId, repository.repository_id AS id,
                  repository.full_name AS fullName
           FROM github_connection_repository AS repository
           INNER JOIN github_connection_context AS context
             ON context.installation_id = repository.installation_id
           WHERE context.broker_reference = ? ORDER BY repository.installation_id, repository.repository_id`,
        )
        .bind(brokerReference)
        .all<{ installationId: number; id: number; fullName: string }>(),
    ])
    return contextResult.results.map((context) => ({
      ...context,
      repositories: repositoryResult.results
        .filter((repository) => repository.installationId === context.installationId)
        .map(({ id, fullName }) => ({ id, fullName })),
    }))
  }

  private async repositoryLifecycleCursors(installationId: number, repositories: readonly GitHubRepositoryChange[]) {
    const repositoryIds = [...new Set(repositories.map((repository) => repository.id))]
    if (repositoryIds.length === 0) return new Map<number, RepositoryLifecycleCursor>()
    const result = await this.db
      .prepare(
        `SELECT repository_id AS repositoryId, provider_updated_at AS providerUpdatedAt, removed
         FROM github_repository_lifecycle_cursor
         WHERE installation_id = ? AND repository_id IN (${repositoryIds.map(() => '?').join(', ')})`,
      )
      .bind(installationId, ...repositoryIds)
      .all<RepositoryLifecycleCursor & { repositoryId: number }>()
    return new Map(result.results.map(({ repositoryId, ...cursor }) => [repositoryId, cursor]))
  }
}

type LifecycleContext = {
  brokerReference: string
  installationId: number
  accountLogin: string
  targetType: string
  status: 'active' | 'suspended'
  scopesJson: string
  repositorySelection: 'all' | 'selected'
  repositories: readonly GitHubRepositoryChange[]
}

type LifecycleCursor = {
  providerUpdatedAt: number
  deletionTerminal: 0 | 1
  restrictiveSuspension: 0 | 1
  restrictiveSelection: 0 | 1
}

type RepositoryLifecycleCursor = { providerUpdatedAt: number; removed: 0 | 1 }

function contextAuthorizationDetail(context: LifecycleContext) {
  return {
    type: 'github_installation',
    installation_id: String(context.installationId),
    account_login: context.accountLogin,
    target_type: context.targetType,
    repository_selection: context.repositorySelection,
    ...(context.repositorySelection === 'selected'
      ? {
          repositories: context.repositories.map((repository) => ({
            id: String(repository.id),
            full_name: repository.fullName,
          })),
        }
      : {}),
  }
}

function nextRepositories(
  current: readonly GitHubRepositoryChange[],
  changes: { added: readonly GitHubRepositoryChange[]; removed: readonly GitHubRepositoryChange[] },
  repositorySelection: GitHubLifecycleChange['repositorySelection'],
) {
  if (repositorySelection === 'all') return []
  const repositories = new Map(current.map((repository) => [repository.id, repository]))
  for (const repository of changes.removed) repositories.delete(repository.id)
  for (const repository of changes.added) repositories.set(repository.id, repository)
  return [...repositories.values()].sort((left, right) => left.id - right.id)
}

function matchesInstallation(input: GitHubLifecycleChange) {
  return (context: LifecycleContext) => context.installationId === input.installationId
}

function effectiveRepositoryChanges(
  input: GitHubLifecycleChange,
  cursors: ReadonlyMap<number, RepositoryLifecycleCursor>,
) {
  const removed = (input.repositoriesRemoved ?? []).filter((repository) => {
    const cursor = cursors.get(repository.id)
    return !cursor || input.providerUpdatedAt >= cursor.providerUpdatedAt
  })
  const removedIds = new Set(removed.map((repository) => repository.id))
  const added = (input.repositoriesAdded ?? []).filter((repository) => {
    if (removedIds.has(repository.id)) return false
    const cursor = cursors.get(repository.id)
    return (
      !cursor ||
      input.providerUpdatedAt > cursor.providerUpdatedAt ||
      (input.providerUpdatedAt === cursor.providerUpdatedAt && cursor.removed === 0)
    )
  })
  return { added, removed }
}

function repositoryLifecycleCursorStatement(
  db: D1Database,
  input: GitHubLifecycleChange,
  repository: GitHubRepositoryChange,
  removed: boolean,
  now: number,
  brokerReference: string,
  revision: number,
) {
  return db
    .prepare(
      `INSERT INTO github_repository_lifecycle_cursor
        (installation_id, repository_id, provider_updated_at, removed, updated_at)
       SELECT ?, ?, ?, ?, ? WHERE EXISTS (
         SELECT 1 FROM github_connection_binding
         WHERE broker_reference = ? AND event_revision = ? AND lifecycle_claim = ?
       )
       ON CONFLICT(installation_id, repository_id) DO UPDATE SET
         provider_updated_at = excluded.provider_updated_at,
         removed = CASE
           WHEN excluded.provider_updated_at > provider_updated_at THEN excluded.removed
           ELSE MAX(removed, excluded.removed)
         END,
         updated_at = excluded.updated_at
       WHERE excluded.provider_updated_at >= provider_updated_at`,
    )
    .bind(
      input.installationId,
      repository.id,
      input.providerUpdatedAt,
      removed ? 1 : 0,
      now,
      brokerReference,
      revision,
      input.deliveryId,
    )
}

function intersectScopes(current: readonly string[], incoming: readonly string[]) {
  const allowed = new Set(incoming)
  return current.filter((scope) => allowed.has(scope)).sort()
}

function webhookDeliveryConflict() {
  return new HttpProblem(
    409,
    'urn:realmroot:adapter:webhook-delivery-conflict',
    'Conflict',
    'The GitHub delivery ID was already used for a different payload.',
  )
}

function lifecycleEventType(
  type: GitHubLifecycleChange['type'],
  previous: readonly LifecycleContext[],
  active: readonly LifecycleContext[],
): GitHubLifecycleEvent['type'] {
  if (active.length === 0) return type === 'suspended' ? 'suspended' : 'revoked'
  if (type === 'restored' && previous.every((context) => context.status === 'suspended')) return 'restored'
  if (type === 'authorityChanged') return 'authorityChanged'
  return 'resourcesChanged'
}
