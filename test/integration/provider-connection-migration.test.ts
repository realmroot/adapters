import { applyD1Migrations, env } from 'cloudflare:test'
import { describe, expect, it } from 'vitest'

describe('Provider connection migration', () => {
  it('[spec: github-adapter/github-lifecycle-migration] revokes legacy unknown repository authority before reconnecting', async () => {
    const legacy = env.TEST_MIGRATIONS.slice(0, 2)
    const lifecycle = env.TEST_MIGRATIONS.slice(2, 3)
    const installationOwnership = env.TEST_MIGRATIONS.slice(3, 4)
    const transparentScopes = env.TEST_MIGRATIONS.slice(4, 5)
    const linearConnections = env.TEST_MIGRATIONS.slice(5, 6)
    const webhookLifecycle = env.TEST_MIGRATIONS.slice(6, 7)
    const externalAuthorizationServer = env.TEST_MIGRATIONS.slice(7, 8)
    const linearAuthorizationCleanup = env.TEST_MIGRATIONS.slice(8, 9)
    const githubDelegatedCredentials = env.TEST_MIGRATIONS.slice(9, 10)
    expect(legacy).toHaveLength(2)
    expect(lifecycle).toHaveLength(1)
    expect(installationOwnership).toHaveLength(1)
    expect(transparentScopes).toHaveLength(1)
    expect(linearConnections).toHaveLength(1)
    expect(webhookLifecycle).toHaveLength(1)
    expect(externalAuthorizationServer).toHaveLength(1)
    expect(linearAuthorizationCleanup).toHaveLength(1)
    expect(githubDelegatedCredentials).toHaveLength(1)
    await applyD1Migrations(env.MIGRATION_DB, legacy)
    const now = Date.now()
    await env.MIGRATION_DB.batch([
      env.MIGRATION_DB.prepare(
        `INSERT INTO github_connection_intent
          (request_id, connection_id, expected_external_subject, owner_subject, realmroot_state, callback_uri,
           code_challenge, scopes_json, provider_state_hash, github_user_id, github_login, authorization_code_hash,
           status, expires_at, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'exchanged', ?, ?, ?)`,
      ).bind(
        'request-legacy',
        'broker-legacy',
        null,
        'user-legacy',
        'state-legacy',
        'https://id.example/callback',
        'challenge-legacy',
        '["github:metadata:read"]',
        'provider-state-hash',
        7,
        'controller',
        'authorization-code-hash',
        now + 60_000,
        now,
        now,
      ),
      env.MIGRATION_DB.prepare(
        `INSERT INTO github_connection_binding
          (connection_id, github_user_id, github_login, display_name, scopes_json, status, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, 'active', ?, ?)`,
      ).bind('broker-legacy', 7, 'controller', 'Controller', '["github:metadata:read"]', now, now),
      env.MIGRATION_DB.prepare(
        `INSERT INTO github_connection_context
          (connection_id, installation_id, account_login, target_type, created_at)
         VALUES (?, ?, ?, ?, ?)`,
      ).bind('broker-legacy', 101, 'realmroot', 'Organization', now),
      env.MIGRATION_DB.prepare(
        `INSERT INTO github_connection_binding
          (connection_id, github_user_id, github_login, display_name, scopes_json, status, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, 'active', ?, ?)`,
      ).bind('broker-orphan', 8, 'orphan', 'Orphan', '[]', now, now),
      env.MIGRATION_DB.prepare(
        `INSERT INTO github_connection_context
          (connection_id, installation_id, account_login, target_type, created_at)
         VALUES (?, ?, ?, ?, ?)`,
      ).bind('broker-orphan', 102, 'orphan', 'User', now),
    ])

    await applyD1Migrations(env.MIGRATION_DB, lifecycle)
    await applyD1Migrations(env.MIGRATION_DB, installationOwnership)
    await applyD1Migrations(env.MIGRATION_DB, transparentScopes)
    await applyD1Migrations(env.MIGRATION_DB, linearConnections)
    await applyD1Migrations(env.MIGRATION_DB, webhookLifecycle)
    await applyD1Migrations(env.MIGRATION_DB, externalAuthorizationServer)

    await expect(
      env.MIGRATION_DB.prepare(
        `SELECT broker_reference AS brokerReference, owner_subject AS ownerSubject,
                event_revision AS eventRevision, lifecycle_claim AS lifecycleClaim
         FROM github_connection_binding WHERE broker_reference = ?`,
      )
        .bind('broker-legacy')
        .first(),
    ).resolves.toEqual({
      brokerReference: 'broker-legacy',
      ownerSubject: 'user-legacy',
      eventRevision: 1,
      lifecycleClaim: null,
    })
    await expect(
      env.MIGRATION_DB.prepare(
        'SELECT scopes_json AS scopesJson FROM github_connection_binding WHERE broker_reference = ?',
      )
        .bind('broker-legacy')
        .first(),
    ).resolves.toEqual({ scopesJson: '["metadata:read"]' })
    await expect(
      env.MIGRATION_DB.prepare(
        "SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'idempotency_response'",
      ).first(),
    ).resolves.toBeNull()
    await expect(
      env.MIGRATION_DB.prepare('SELECT installation_id FROM github_connection_context WHERE broker_reference = ?')
        .bind('broker-legacy')
        .first(),
    ).resolves.toBeNull()
    await expect(
      env.MIGRATION_DB.prepare('SELECT status FROM github_connection_binding WHERE broker_reference = ?')
        .bind('broker-legacy')
        .first(),
    ).resolves.toEqual({ status: 'revoked' })
    const pending = await env.MIGRATION_DB.prepare(
      "SELECT delivery_id AS deliveryId, event_json AS eventJson, state FROM github_webhook_delivery WHERE state = 'pending'",
    ).first<{ deliveryId: string; eventJson: string; state: string }>()
    expect(pending).toMatchObject({ deliveryId: 'migration-0007-broker-legacy', state: 'pending' })
    expect(JSON.parse(pending?.eventJson ?? '{}')).toMatchObject({
      id: 'migration-0007-broker-legacy',
      type: 'revoked',
      brokerReference: 'broker-legacy',
      revision: 1,
    })
    await env.MIGRATION_DB.prepare("UPDATE github_webhook_delivery SET state = 'completed' WHERE delivery_id = ?")
      .bind('migration-0007-broker-legacy')
      .run()
    await expect(
      env.MIGRATION_DB.prepare('SELECT state FROM github_webhook_delivery WHERE delivery_id = ?')
        .bind('migration-0007-broker-legacy')
        .first(),
    ).resolves.toEqual({ state: 'completed' })
    await expect(
      env.MIGRATION_DB.prepare(
        "SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'github_webhook_delivery'",
      ).first(),
    ).resolves.toEqual({ name: 'github_webhook_delivery' })
    await expect(
      env.MIGRATION_DB.prepare(
        "SELECT COUNT(*) AS count FROM sqlite_master WHERE type = 'table' AND name IN ('github_connection_repository', 'github_installation_lifecycle_cursor', 'github_repository_lifecycle_cursor')",
      ).first(),
    ).resolves.toEqual({ count: 3 })
    await expect(
      env.MIGRATION_DB.prepare('SELECT broker_reference FROM github_connection_binding WHERE broker_reference = ?')
        .bind('broker-orphan')
        .first(),
    ).resolves.toBeNull()
    await env.MIGRATION_DB.prepare(
      `INSERT INTO github_connection_binding
        (broker_reference, owner_subject, github_user_id, github_login, display_name, scopes_json, status, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, 'active', ?, ?)`,
    )
      .bind('broker-reconnected', 'user-legacy', 8, 'other', 'Other', '[]', now, now)
      .run()
    await env.MIGRATION_DB.prepare(
      `INSERT INTO github_connection_context
        (broker_reference, installation_id, account_login, target_type, created_at)
       VALUES (?, ?, ?, ?, ?)`,
    )
      .bind('broker-reconnected', 101, 'realmroot', 'Organization', now)
      .run()
    await env.MIGRATION_DB.prepare(
      `INSERT INTO github_connection_binding
        (broker_reference, owner_subject, github_user_id, github_login, display_name, scopes_json, status, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, 'active', ?, ?)`,
    )
      .bind('broker-installation-conflict', 'other-user', 8, 'other', 'Other', '[]', now, now)
      .run()
    await expect(
      env.MIGRATION_DB.prepare(
        `INSERT INTO github_connection_context
          (broker_reference, installation_id, account_login, target_type, created_at)
         VALUES (?, ?, ?, ?, ?)`,
      )
        .bind('broker-installation-conflict', 101, 'realmroot', 'Organization', now)
        .run(),
    ).rejects.toThrow()
    await expect(env.MIGRATION_DB.prepare('PRAGMA foreign_key_check').all()).resolves.toMatchObject({ results: [] })
    await expect(
      env.MIGRATION_DB.prepare(
        "SELECT COUNT(*) AS count FROM sqlite_master WHERE type = 'table' AND name IN ('external_oauth_client', 'external_oauth_intent', 'external_oauth_code', 'external_oauth_refresh', 'external_oauth_access', 'cloudflare_external_credential')",
      ).first(),
    ).resolves.toEqual({ count: 6 })

    await env.MIGRATION_DB.batch([
      env.MIGRATION_DB.prepare(
        `INSERT INTO external_oauth_client
          (client_id, provider_id, client_secret_hash, redirect_uris_json, jwks_uri, created_at)
         VALUES (?, 'github', ?, '[]', ?, ?)`,
      ).bind('github-client', 'hash', 'https://id.example/jwks', now),
      env.MIGRATION_DB.prepare(
        `INSERT INTO external_oauth_refresh
          (token_hash, provider_id, client_id, subject, display_name, scope_json,
           authorization_details_json, created_at, updated_at)
         VALUES (?, 'github', ?, ?, ?, '[]', '[]', ?, ?)`,
      ).bind('refresh-hash', 'github-client', '7', 'Controller', now, now),
    ])
    await applyD1Migrations(env.MIGRATION_DB, linearAuthorizationCleanup)
    await applyD1Migrations(env.MIGRATION_DB, githubDelegatedCredentials)

    await expect(
      env.MIGRATION_DB.prepare(
        "SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'github_user_credential'",
      ).first(),
    ).resolves.toEqual({ name: 'github_user_credential' })
    await expect(
      env.MIGRATION_DB.prepare(
        "SELECT revoked_at IS NOT NULL AS revoked FROM external_oauth_refresh WHERE provider_id = 'github'",
      ).first(),
    ).resolves.toEqual({ revoked: 0 })
    await expect(
      env.MIGRATION_DB.prepare(
        "SELECT COUNT(*) AS count FROM github_connection_binding WHERE status = 'active'",
      ).first(),
    ).resolves.toEqual({ count: 2 })
    await expect(
      env.MIGRATION_DB.prepare('SELECT COUNT(*) AS count FROM github_connection_context').first(),
    ).resolves.toEqual({ count: 1 })
  })
})
