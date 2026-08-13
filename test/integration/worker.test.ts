import { env, SELF } from 'cloudflare:test'
import { describe, expect, it } from 'vitest'
import { sha256Base64Url } from '../../src/core/digest.js'
import { D1GitHubConnections } from '../../src/providers/github/connections.js'
import { D1RuntimeState } from '../../src/storage/d1-runtime-state.js'

describe('Cloudflare Worker runtime', () => {
  it('serves the adapter through the workerd entrypoint', async () => {
    const response = await SELF.fetch('https://adapter.example/health')
    expect(response.status).toBe(200)
    await expect(response.json()).resolves.toEqual({ status: 'ok' })
  })

  it('persists replay protection and audit state in real D1', async () => {
    const state = new D1RuntimeState(env.DB)
    const proof = { keyThumbprint: 'thumbprint', jti: 'proof-1', now: 1_000, expiresAt: 301_000 }
    await expect(state.claim(proof)).resolves.toBe(true)
    await expect(state.claim(proof)).resolves.toBe(false)

    await state.recordAudit({
      requestId: 'request-1',
      event: 'provider.operation',
      occurredAt: new Date().toISOString(),
    })
    const audit = await env.DB.prepare('SELECT event_json FROM adapter_audit_event WHERE request_id = ?')
      .bind('request-1')
      .first<{ event_json: string }>()
    expect(JSON.parse(audit?.event_json ?? '{}')).toMatchObject({ event: 'provider.operation' })
  })

  it('[spec: github-adapter/github-provider-connection] keeps one owner binding across reauthorization', async () => {
    const connections = new D1GitHubConnections(env.DB, new D1RuntimeState(env.DB))
    const verifier = 'realmroot-pkce-verifier-with-sufficient-entropy'
    const request = {
      sub: 'user-1',
      jti: 'request-1',
      state: 'realmroot-state',
      connection_id: 'connection-1',
      expected_external_subject: null,
      owner_type: 'user' as const,
      callback_uri: 'https://realmroot.example/api/account-connections/oauth/callback',
      code_challenge: await sha256Base64Url(verifier),
      code_challenge_method: 'S256' as const,
      scope: 'metadata:read issues:write',
      authorization_details: [{ type: 'github_installation' }],
    }
    await connections.create(request, 'provider-state')
    const intent = await connections.findByProviderState('provider-state', 'pending_oauth')
    await connections.complete(
      intent,
      { id: 7, login: 'controller', name: 'Controller' },
      [
        {
          id: 101,
          accountLogin: 'realmroot',
          targetType: 'Organization',
          permissions: { metadata: 'read', issues: 'write' },
          repositorySelection: 'selected',
          repositories: [{ id: 1, fullName: 'realmroot/adapter' }],
          updatedAt: '2027-01-15T07:00:00.000Z',
        },
        {
          id: 102,
          accountLogin: 'controller',
          targetType: 'User',
          permissions: { metadata: 'read', issues: 'write' },
          repositorySelection: 'all',
          repositories: [],
          updatedAt: '2027-01-15T07:00:00.000Z',
        },
      ],
      'connection-code',
    )
    const result = await connections.exchange('connection-code', verifier, 'request-1')
    expect(result.intent.connectionId).toBe('connection-1')
    expect(result.brokerReference).toBe('connection-1')
    expect(result.contexts.map((context) => context.installationId)).toEqual([101, 102])
    await expect(connections.activeInstallationsForOwner('user-1', 'connection-1')).resolves.toEqual([
      {
        installationId: 101,
        accountLogin: 'realmroot',
        targetType: 'Organization',
        scopes: ['issues:read', 'issues:write', 'metadata:read'],
        repositorySelection: 'selected',
        repositories: [{ id: 1, fullName: 'realmroot/adapter' }],
      },
      {
        installationId: 102,
        accountLogin: 'controller',
        targetType: 'User',
        scopes: ['issues:read', 'issues:write', 'metadata:read'],
        repositorySelection: 'all',
        repositories: [],
      },
    ])
    await expect(connections.exchange('connection-code', verifier, 'request-1')).rejects.toThrow(
      'Connection code is invalid',
    )

    await connections.create(
      {
        ...request,
        jti: 'request-2',
        connection_id: 'canonical-provider-connection',
        expected_external_subject: '7',
      },
      'provider-state-2',
    )
    const reconnect = await connections.findByProviderState('provider-state-2', 'pending_oauth')
    await connections.complete(
      reconnect,
      { id: 7, login: 'controller', name: 'Controller' },
      [
        {
          id: 103,
          accountLogin: 'realmroot',
          targetType: 'Organization',
          permissions: { metadata: 'read', issues: 'write' },
          repositorySelection: 'all',
          repositories: [],
          updatedAt: '2027-01-15T07:00:00.000Z',
        },
      ],
      'connection-code-2',
    )
    const reconnected = await connections.exchange('connection-code-2', verifier, 'request-2')
    expect(reconnected.brokerReference).toBe('connection-1')
    await expect(connections.activeInstallationsForOwner('user-1', 'connection-1')).resolves.toEqual([
      {
        installationId: 103,
        accountLogin: 'realmroot',
        targetType: 'Organization',
        scopes: ['issues:read', 'issues:write', 'metadata:read'],
        repositorySelection: 'all',
        repositories: [],
      },
    ])
    await expect(connections.activeInstallationsForOwner('user-1', 'canonical-provider-connection')).rejects.toThrow(
      'Active GitHub account connection is required',
    )
    const active = await env.DB.prepare(
      "SELECT COUNT(*) AS count FROM github_connection_binding WHERE owner_subject = ? AND status = 'active'",
    )
      .bind('user-1')
      .first<{ count: number }>()
    expect(active?.count).toBe(1)
  })

  it('[spec: github-adapter/github-provider-revocation] atomically revokes one broker reference and rejects replay', async () => {
    const connections = new D1GitHubConnections(env.DB, new D1RuntimeState(env.DB))
    const verifier = 'realmroot-pkce-verifier-with-sufficient-entropy'
    const request = {
      sub: 'user-revoke',
      jti: 'request-revoke',
      state: 'realmroot-state',
      connection_id: 'broker-revoke',
      expected_external_subject: null,
      owner_type: 'user' as const,
      callback_uri: 'https://realmroot.example/api/account-connections/oauth/callback',
      code_challenge: await sha256Base64Url(verifier),
      code_challenge_method: 'S256' as const,
      scope: 'metadata:read',
      authorization_details: [{ type: 'github_installation' }],
    }
    await connections.create(request, 'provider-state-revoke')
    const intent = await connections.findByProviderState('provider-state-revoke', 'pending_oauth')
    await connections.complete(
      intent,
      { id: 8, login: 'controller', name: 'Controller' },
      [
        {
          id: 201,
          accountLogin: 'realmroot',
          targetType: 'Organization',
          permissions: { metadata: 'read' },
          repositorySelection: 'all',
          repositories: [],
          updatedAt: '2027-01-15T07:00:00.000Z',
        },
      ],
      'connection-code-revoke',
    )
    await connections.exchange('connection-code-revoke', verifier, 'request-revoke')

    const revocation = {
      brokerReference: 'broker-revoke',
      ownerSubject: 'user-revoke',
      jti: 'revocation-1',
      expiresAt: Date.now() + 60_000,
    }
    await connections.revoke(revocation)
    await expect(connections.activeInstallationsForOwner('user-revoke', 'broker-revoke')).rejects.toThrow(
      'Active GitHub account connection is required',
    )

    await connections.create(
      {
        ...request,
        jti: 'request-reconnect',
        expected_external_subject: '8',
      },
      'provider-state-reconnect',
    )
    const reconnect = await connections.findByProviderState('provider-state-reconnect', 'pending_oauth')
    await connections.complete(
      reconnect,
      { id: 8, login: 'controller', name: 'Controller' },
      [
        {
          id: 202,
          accountLogin: 'realmroot',
          targetType: 'Organization',
          permissions: { metadata: 'read' },
          repositorySelection: 'all',
          repositories: [],
          updatedAt: '2027-01-15T07:00:00.000Z',
        },
      ],
      'connection-code-reconnect',
    )
    await connections.exchange('connection-code-reconnect', verifier, 'request-reconnect')

    await expect(connections.revoke(revocation)).rejects.toThrow('revocation request was already used')
    await expect(connections.activeInstallationsForOwner('user-revoke', 'broker-revoke')).resolves.toEqual([
      {
        installationId: 202,
        accountLogin: 'realmroot',
        targetType: 'Organization',
        scopes: ['metadata:read'],
        repositorySelection: 'all',
        repositories: [],
      },
    ])
  })

  it('[spec: github-adapter/github-installation-lifecycle] immediately updates provider-private installation context', async () => {
    const now = Date.now()
    const connections = new D1GitHubConnections(env.DB, new D1RuntimeState(env.DB))
    await env.DB.batch([
      env.DB.prepare(
        `INSERT INTO github_connection_binding
            (broker_reference, owner_subject, github_user_id, github_login, display_name, scopes_json, status, created_at, updated_at)
           VALUES (?, ?, ?, ?, ?, ?, 'active', ?, ?)`,
      ).bind(
        'broker-lifecycle',
        'user-lifecycle',
        9,
        'controller',
        'Controller',
        '["issues:read","issues:write","metadata:read"]',
        now,
        now,
      ),
      env.DB.prepare(
        `INSERT INTO github_connection_context
            (broker_reference, installation_id, account_login, target_type, created_at, status, scopes_json, updated_at, repository_selection)
           VALUES (?, ?, ?, ?, ?, 'active', ?, ?, 'all')`,
      ).bind(
        'broker-lifecycle',
        301,
        'realmroot',
        'Organization',
        now,
        '["issues:read","issues:write","metadata:read"]',
        now,
      ),
      env.DB.prepare(
        `INSERT INTO github_connection_context
            (broker_reference, installation_id, account_login, target_type, created_at, status, scopes_json, updated_at, repository_selection)
           VALUES (?, ?, ?, ?, ?, 'active', ?, ?, 'all')`,
      ).bind('broker-lifecycle', 302, 'controller', 'User', now, '["metadata:read"]', now),
    ])

    const partialSuspension = await connections.prepareLifecycleEvent({
      deliveryId: 'lifecycle-suspend-301',
      fingerprint: 'fingerprint-suspend-301',
      type: 'suspended',
      installationId: 301,
      occurredAt: '2027-01-15T08:00:00.000Z',
      providerUpdatedAt: Date.parse('2027-01-15T08:00:00.000Z'),
    })
    expect(partialSuspension.event).toMatchObject({
      type: 'resourcesChanged',
      revision: 1,
      brokerReference: 'broker-lifecycle',
      scopes: ['metadata:read'],
      authorizationDetails: [{ installation_id: '302' }],
      authorityConstraints: [
        {
          authorizationDetails: [{ installation_id: '302' }],
          scopes: ['metadata:read'],
        },
      ],
    })
    await expect(connections.activeInstallationsForOwner('user-lifecycle', 'broker-lifecycle')).resolves.toEqual([
      {
        installationId: 302,
        accountLogin: 'controller',
        targetType: 'User',
        scopes: ['metadata:read'],
        repositorySelection: 'all',
        repositories: [],
      },
    ])

    await expect(
      connections.prepareLifecycleEvent({
        deliveryId: 'lifecycle-ambiguous-restore-301',
        fingerprint: 'fingerprint-ambiguous-restore-301',
        type: 'restored',
        installationId: 301,
        occurredAt: '2027-01-15T08:00:00.000Z',
        providerUpdatedAt: Date.parse('2027-01-15T08:00:00.000Z'),
      }),
    ).resolves.toEqual({ event: null, completed: true })
    await expect(connections.activeInstallationsForOwner('user-lifecycle', 'broker-lifecycle')).resolves.toEqual([
      {
        installationId: 302,
        accountLogin: 'controller',
        targetType: 'User',
        scopes: ['metadata:read'],
        repositorySelection: 'all',
        repositories: [],
      },
    ])

    const fullSuspension = await connections.prepareLifecycleEvent({
      deliveryId: 'lifecycle-suspend-302',
      fingerprint: 'fingerprint-suspend-302',
      type: 'suspended',
      installationId: 302,
      occurredAt: '2027-01-15T08:01:00.000Z',
      providerUpdatedAt: Date.parse('2027-01-15T08:01:00.000Z'),
    })
    expect(fullSuspension.event).toMatchObject({ type: 'suspended' })
    expect(fullSuspension.event).not.toHaveProperty('scopes')
    expect(fullSuspension.event).not.toHaveProperty('authorizationDetails')
    expect(fullSuspension.event).not.toHaveProperty('authorityConstraints')
    expect(fullSuspension.event?.revision).toBe(2)
    await expect(connections.activeInstallationsForOwner('user-lifecycle', 'broker-lifecycle')).rejects.toThrow(
      'Active GitHub account connection is required',
    )

    const restored = await connections.prepareLifecycleEvent({
      deliveryId: 'lifecycle-restore-301',
      fingerprint: 'fingerprint-restore-301',
      type: 'restored',
      installationId: 301,
      occurredAt: '2027-01-15T08:02:00.000Z',
      providerUpdatedAt: Date.parse('2027-01-15T08:02:00.000Z'),
    })
    expect(restored.event).toMatchObject({
      type: 'restored',
      scopes: ['issues:read', 'issues:write', 'metadata:read'],
      authorityConstraints: [
        {
          authorizationDetails: [{ installation_id: '301' }],
          scopes: ['issues:read', 'issues:write', 'metadata:read'],
        },
      ],
    })

    const concurrentAuthority = await Promise.all([
      connections.prepareLifecycleEvent({
        deliveryId: 'lifecycle-authority-301',
        fingerprint: 'fingerprint-authority-301',
        type: 'authorityChanged',
        installationId: 301,
        occurredAt: '2027-01-15T08:03:00.000Z',
        providerUpdatedAt: Date.parse('2027-01-15T08:03:00.000Z'),
        scopes: ['metadata:read'],
      }),
      connections.prepareLifecycleEvent({
        deliveryId: 'lifecycle-authority-expansion-301',
        fingerprint: 'fingerprint-authority-expansion-301',
        type: 'authorityChanged',
        installationId: 301,
        occurredAt: '2027-01-15T08:03:00.000Z',
        providerUpdatedAt: Date.parse('2027-01-15T08:03:00.000Z'),
        scopes: ['issues:write', 'metadata:read'],
      }),
    ])
    const eventsByRevision = concurrentAuthority
      .map((prepared) => prepared.event)
      .filter((event) => event !== null)
      .sort((left, right) => left.revision - right.revision)
    expect(eventsByRevision.map((event) => event.revision)).toEqual([4, 5])
    expect(eventsByRevision.at(-1)).toMatchObject({
      type: 'authorityChanged',
      scopes: ['metadata:read'],
      affectedScopes: ['metadata:read'],
      affectedAuthorizationDetails: [{ installation_id: '301' }],
      authorityConstraints: [
        {
          authorizationDetails: [{ installation_id: '301' }],
          scopes: ['metadata:read'],
        },
      ],
    })
    await expect(connections.activeInstallationsForOwner('user-lifecycle', 'broker-lifecycle')).resolves.toMatchObject([
      { installationId: 301, scopes: ['metadata:read'] },
    ])

    const revoked = await connections.prepareLifecycleEvent({
      deliveryId: 'lifecycle-delete-301',
      fingerprint: 'fingerprint-delete-301',
      type: 'deleted',
      installationId: 301,
      occurredAt: '2027-01-15T08:04:00.000Z',
      providerUpdatedAt: Date.parse('2027-01-15T08:04:00.000Z'),
    })
    expect(revoked.event).toMatchObject({ type: 'revoked' })
    expect(revoked.event).not.toHaveProperty('scopes')
    expect(revoked.event).not.toHaveProperty('authorizationDetails')
    expect(revoked.event).not.toHaveProperty('authorityConstraints')

    await expect(
      connections.prepareLifecycleEvent({
        deliveryId: 'lifecycle-restore-after-delete-301',
        fingerprint: 'fingerprint-restore-after-delete-301',
        type: 'restored',
        installationId: 301,
        occurredAt: '2027-01-15T08:05:00.000Z',
        providerUpdatedAt: Date.parse('2027-01-15T08:05:00.000Z'),
      }),
    ).resolves.toEqual({ event: null, completed: true })
  })

  it('[spec: github-adapter/github-installation-resources] durably deduplicates repository deliveries', async () => {
    const now = Date.now()
    const connections = new D1GitHubConnections(env.DB, new D1RuntimeState(env.DB))
    await env.DB.batch([
      env.DB.prepare(
        `INSERT INTO github_connection_binding
            (broker_reference, owner_subject, github_user_id, github_login, display_name, scopes_json, status, created_at, updated_at)
           VALUES (?, ?, ?, ?, ?, ?, 'active', ?, ?)`,
      ).bind('broker-resources', 'user-resources', 10, 'controller', 'Controller', '["metadata:read"]', now, now),
      env.DB.prepare(
        `INSERT INTO github_connection_context
            (broker_reference, installation_id, account_login, target_type, created_at, status, scopes_json, updated_at)
           VALUES (?, ?, ?, ?, ?, 'active', ?, ?)`,
      ).bind('broker-resources', 401, 'realmroot', 'Organization', now, '["metadata:read"]', now),
    ])
    const change = {
      deliveryId: 'resources-401',
      fingerprint: 'fingerprint-resources-401',
      type: 'resourcesChanged' as const,
      installationId: 401,
      occurredAt: '2027-01-15T08:00:00.000Z',
      providerUpdatedAt: Date.parse('2027-01-15T08:00:00.000Z'),
      repositorySelection: 'selected' as const,
      repositoriesAdded: [{ id: 11, fullName: 'realmroot/adapter' }],
      repositoriesRemoved: [],
    }

    const prepared = await connections.prepareLifecycleEvent(change)
    expect(prepared).toMatchObject({
      completed: false,
      event: {
        type: 'resourcesChanged',
        authorizationDetails: [
          {
            installation_id: '401',
            repository_selection: 'selected',
            repositories: [{ id: '11', full_name: 'realmroot/adapter' }],
          },
        ],
        authorityConstraints: [
          {
            authorizationDetails: [
              {
                installation_id: '401',
                repository_selection: 'selected',
                repositories: [{ id: '11', full_name: 'realmroot/adapter' }],
              },
            ],
            scopes: ['metadata:read'],
          },
        ],
      },
    })
    await Promise.all([
      connections.completeLifecycleEvent(change.deliveryId),
      connections.completeLifecycleEvent(change.deliveryId),
    ])
    await expect(connections.prepareLifecycleEvent(change)).resolves.toMatchObject({
      completed: true,
      event: { id: change.deliveryId, type: 'resourcesChanged' },
    })
    await expect(
      connections.prepareLifecycleEvent({ ...change, fingerprint: 'different-payload-fingerprint' }),
    ).rejects.toThrow('delivery ID was already used for a different payload')

    const removedAndAdded = await connections.prepareLifecycleEvent({
      ...change,
      deliveryId: 'resources-remove-11-add-12',
      fingerprint: 'fingerprint-remove-11-add-12',
      repositoriesAdded: [{ id: 12, fullName: 'realmroot/core' }],
      repositoriesRemoved: [{ id: 11, fullName: 'realmroot/adapter' }],
    })
    expect(removedAndAdded).toMatchObject({
      completed: false,
      event: { authorizationDetails: [{ repositories: [{ id: '12', full_name: 'realmroot/core' }] }] },
    })

    const ambiguousRestoreAndIndependentAdd = await connections.prepareLifecycleEvent({
      ...change,
      deliveryId: 'resources-add-11-add-13',
      fingerprint: 'fingerprint-add-11-add-13',
      repositoriesAdded: [
        { id: 11, fullName: 'realmroot/adapter' },
        { id: 13, fullName: 'realmroot/docs' },
      ],
      repositoriesRemoved: [],
    })
    expect(ambiguousRestoreAndIndependentAdd).toMatchObject({
      completed: false,
      event: {
        authorizationDetails: [
          {
            repositories: [
              { id: '12', full_name: 'realmroot/core' },
              { id: '13', full_name: 'realmroot/docs' },
            ],
          },
        ],
      },
    })
    await expect(connections.activeInstallationsForOwner('user-resources', 'broker-resources')).resolves.toMatchObject([
      {
        repositories: [
          { id: 12, fullName: 'realmroot/core' },
          { id: 13, fullName: 'realmroot/docs' },
        ],
      },
    ])
  })

  it('durably completes supported deliveries for installations with no connected context', async () => {
    const connections = new D1GitHubConnections(env.DB, new D1RuntimeState(env.DB))
    const unknown = {
      deliveryId: 'unknown-installation-delivery',
      fingerprint: 'unknown-installation-fingerprint',
      type: 'deleted' as const,
      installationId: 999_999,
      occurredAt: '2027-01-15T08:00:00.000Z',
      providerUpdatedAt: Date.parse('2027-01-15T08:00:00.000Z'),
    }

    await expect(
      Promise.all([connections.prepareLifecycleEvent(unknown), connections.prepareLifecycleEvent(unknown)]),
    ).resolves.toEqual([
      { event: null, completed: true },
      { event: null, completed: true },
    ])
    await expect(
      env.DB.prepare('SELECT state, event_json AS eventJson FROM github_webhook_delivery WHERE delivery_id = ?')
        .bind(unknown.deliveryId)
        .first(),
    ).resolves.toEqual({ state: 'completed', eventJson: 'null' })
  })

  it('[spec: github-adapter/provider-isolation] keeps health available when provider modules are not configured', async () => {
    const now = Date.now()
    await env.DB.prepare(
      `INSERT INTO github_webhook_delivery
        (delivery_id, fingerprint, event_json, state, created_at, updated_at)
       VALUES (?, ?, ?, 'pending', ?, ?)`,
    )
      .bind(
        'blocked-github-outbox',
        'migration-0007',
        JSON.stringify({
          id: 'blocked-github-outbox',
          type: 'revoked',
          brokerReference: 'blocked-broker',
          occurredAt: new Date(now).toISOString(),
          revision: 1,
        }),
        now,
        now,
      )
      .run()

    await expect(SELF.fetch('https://adapter.example/health')).resolves.toMatchObject({ status: 200 })
    await expect(SELF.fetch('https://adapter.example/linear')).resolves.toMatchObject({ status: 404 })
    await expect(SELF.fetch('https://adapter.example/github')).resolves.toMatchObject({ status: 404 })
  })
})
