import { applyD1Migrations, env } from 'cloudflare:test'
import { describe, expect, it } from 'vitest'

describe('Provider connection migration', () => {
  it('upgrades a legacy GitHub binding without changing its broker reference or owner', async () => {
    const legacy = env.TEST_MIGRATIONS.slice(0, 2)
    const lifecycle = env.TEST_MIGRATIONS.slice(2, 3)
    const installationOwnership = env.TEST_MIGRATIONS.slice(3, 4)
    const transparentScopes = env.TEST_MIGRATIONS.slice(4)
    expect(legacy).toHaveLength(2)
    expect(lifecycle).toHaveLength(1)
    expect(installationOwnership).toHaveLength(1)
    expect(transparentScopes).toHaveLength(1)
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

    await expect(
      env.MIGRATION_DB.prepare(
        `SELECT broker_reference AS brokerReference, owner_subject AS ownerSubject
         FROM github_connection_binding WHERE broker_reference = ?`,
      )
        .bind('broker-legacy')
        .first(),
    ).resolves.toEqual({ brokerReference: 'broker-legacy', ownerSubject: 'user-legacy' })
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
      env.MIGRATION_DB.prepare(
        'SELECT installation_id AS installationId FROM github_connection_context WHERE broker_reference = ?',
      )
        .bind('broker-legacy')
        .first(),
    ).resolves.toEqual({ installationId: 101 })
    await expect(
      env.MIGRATION_DB.prepare('SELECT broker_reference FROM github_connection_binding WHERE broker_reference = ?')
        .bind('broker-orphan')
        .first(),
    ).resolves.toBeNull()
    await expect(
      env.MIGRATION_DB.prepare(
        `INSERT INTO github_connection_binding
          (broker_reference, owner_subject, github_user_id, github_login, display_name, scopes_json, status, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, 'active', ?, ?)`,
      )
        .bind('broker-conflict', 'user-legacy', 8, 'other', 'Other', '[]', now, now)
        .run(),
    ).rejects.toThrow()
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
  })
})
