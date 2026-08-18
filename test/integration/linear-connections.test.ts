import { env } from 'cloudflare:test'
import { describe, expect, it } from 'vitest'
import { sha256Base64Url } from '../../src/core/digest.js'
import { D1LinearConnections } from '../../src/providers/linear/connections.js'
import { createLinearCredentialCipher } from '../../src/providers/linear/credentials.js'
import { D1RuntimeState } from '../../src/storage/d1-runtime-state.js'

const cipher = createLinearCredentialCipher('AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA')
const state = new D1RuntimeState(env.DB)

describe('Linear connection persistence', () => {
  it('[spec: linear-adapter/linear-workspace-reauthorization] preserves one user binding with multiple workspace contexts', async () => {
    const store = new D1LinearConnections(env.DB, cipher, state)
    const verifier = 'linear-pkce-verifier-with-sufficient-entropy'
    const first = await request('linear-request-1', 'linear-connection-1', null, verifier)
    await store.create(first, 'linear-user-state-1')
    const userIntent = await store.findByProviderState('linear-user-state-1')
    await store.recordUser(userIntent, humanViewer('linear-user-1'), 'linear-app-state-1')
    const appIntent = await store.findByProviderState('linear-app-state-1')
    await store.complete(appIntent, appViewer('workspace-1', 'app-user-1'), token('access-1', 'refresh-1'), 'code-1')
    const connected = await store.exchange('code-1', verifier, 'linear-request-1')
    expect(connected).toMatchObject({
      brokerReference: 'linear-connection-1',
      binding: { linearUserId: 'linear-user-1' },
    })
    expect(connected.contexts.map((context) => context.workspaceId)).toEqual(['workspace-1'])

    const second = await request('linear-request-2', 'canonical-linear-connection', 'linear-user-1', verifier)
    await store.create(second, 'linear-user-state-2')
    const secondUserIntent = await store.findByProviderState('linear-user-state-2')
    await store.recordUser(secondUserIntent, humanViewer('linear-user-1'), 'linear-app-state-2')
    const secondAppIntent = await store.findByProviderState('linear-app-state-2')
    await store.complete(
      secondAppIntent,
      appViewer('workspace-2', 'app-user-2'),
      token('access-2', 'refresh-2'),
      'code-2',
    )
    const reauthorized = await store.exchange('code-2', verifier, 'linear-request-2')
    expect(reauthorized.brokerReference).toBe('linear-connection-1')
    expect(reauthorized.contexts.map((context) => context.workspaceId).sort()).toEqual(['workspace-1', 'workspace-2'])
    await expect(store.credentialForOwner('linear-owner')).rejects.toThrow('Select exactly one')
    await expect(store.credentialForOwner('linear-owner', 'workspace-2')).resolves.toMatchObject({
      accessToken: 'access-2',
      refreshToken: 'refresh-2',
    })

    const stored = await env.DB.prepare(
      `SELECT access_token_ciphertext AS accessToken, refresh_token_ciphertext AS refreshToken
       FROM linear_connection_context WHERE workspace_id = ?`,
    )
      .bind('workspace-2')
      .first<{ accessToken: string; refreshToken: string }>()
    expect(stored?.accessToken).not.toContain('access-2')
    expect(stored?.refreshToken).not.toContain('refresh-2')

    const other = await request('linear-request-other', 'linear-connection-other', 'linear-user-1', verifier)
    await store.create(other, 'linear-user-state-other')
    const otherIntent = await store.findByProviderState('linear-user-state-other')
    await expect(store.recordUser(otherIntent, humanViewer('different-user'), 'unused-state')).rejects.toThrow(
      'Disconnect the current Linear account',
    )
  })

  it('[spec: linear-adapter/linear-provider-connection] keys external authorization by Linear user while retaining workspace contexts', async () => {
    const store = new D1LinearConnections(env.DB, cipher, state)
    await connectWorkspace(store, 'legacy-owner', 'legacy', 'legacy-workspace', 'legacy-user')

    await store.upsertExternalAuthorization(
      humanViewer('legacy-user').user,
      appViewer('legacy-workspace', 'external-app-user'),
      token('external-access', 'external-refresh'),
    )
    const contexts = await store.upsertExternalAuthorization(
      humanViewer('legacy-user').user,
      appViewer('second-workspace', 'second-app-user'),
      token('second-access', 'second-refresh'),
    )

    expect(contexts.map((context) => context.workspaceId).sort()).toEqual(['legacy-workspace', 'second-workspace'])
    await expect(store.externalAuthorization('legacy-user')).resolves.toMatchObject({
      displayName: 'Jasper Van',
      contexts: expect.arrayContaining([
        expect.objectContaining({ workspaceId: 'legacy-workspace' }),
        expect.objectContaining({ workspaceId: 'second-workspace' }),
      ]),
    })
    await expect(store.externalCredentials('legacy-user')).resolves.toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          brokerReference: 'linear:legacy-user',
          workspaceId: 'legacy-workspace',
          accessToken: 'external-access',
          refreshToken: 'external-refresh',
        }),
        expect.objectContaining({
          brokerReference: 'linear:legacy-user',
          workspaceId: 'second-workspace',
          accessToken: 'second-access',
          refreshToken: 'second-refresh',
        }),
      ]),
    )
    const legacy = await env.DB.prepare(
      `SELECT status, access_token_ciphertext AS accessToken, refresh_token_ciphertext AS refreshToken
       FROM linear_connection_context WHERE broker_reference = ? AND workspace_id = ?`,
    )
      .bind('connection-legacy', 'legacy-workspace')
      .first<{ status: string; accessToken: string; refreshToken: string }>()
    expect(legacy).toEqual({ status: 'revoked', accessToken: '', refreshToken: '' })
  })

  it('serializes rotating refresh credentials with an optimistic lease', async () => {
    const store = new D1LinearConnections(env.DB, cipher, state)
    await connectWorkspace(store, 'refresh-owner', 'refresh', 'refresh-workspace', 'refresh-user')
    const credential = await store.credentialForOwner('refresh-owner', 'refresh-workspace')
    await expect(store.claimRefresh(credential, 2_000)).resolves.toBe(true)
    await expect(store.claimRefresh(credential, 2_001)).resolves.toBe(false)
    await expect(store.replaceCredential(credential, token('access-new', 'refresh-new'), 2_002)).resolves.toBe(true)
    await expect(store.replaceCredential(credential, token('access-lost', 'refresh-lost'), 2_003)).resolves.toBe(false)
    await expect(store.credentialForOwner('refresh-owner', 'refresh-workspace')).resolves.toMatchObject({
      accessToken: 'access-new',
      refreshToken: 'refresh-new',
    })
  })

  it('[spec: linear-adapter/linear-provider-lifecycle] applies fresh permission changes once and revokes one workspace', async () => {
    const store = new D1LinearConnections(env.DB, cipher, state)
    await connectWorkspace(store, 'lifecycle-owner', 'lifecycle-1', 'lifecycle-workspace-1', 'lifecycle-user')
    await connectWorkspace(
      store,
      'lifecycle-owner',
      'lifecycle-2',
      'lifecycle-workspace-2',
      'lifecycle-user',
      'lifecycle-user',
    )
    await store.applyLifecycleWebhook('linear-delivery-1', Date.now() + 60_000, {
      type: 'team-access-changed',
      workspaceId: 'lifecycle-workspace-1',
      appUserId: 'app-lifecycle-workspace-1',
      canAccessAllPublicTeams: false,
      addedTeamIds: ['team-1'],
      removedTeamIds: [],
    })
    await expect(
      store.applyLifecycleWebhook('linear-delivery-1', Date.now() + 60_000, {
        type: 'team-access-changed',
        workspaceId: 'lifecycle-workspace-1',
        appUserId: 'app-lifecycle-workspace-1',
        canAccessAllPublicTeams: false,
        addedTeamIds: ['team-1'],
        removedTeamIds: [],
      }),
    ).rejects.toThrow('already processed')
    const access = await env.DB.prepare(
      `SELECT team_ids_json AS teamIds, can_access_all_public_teams AS allTeams
       FROM linear_connection_context WHERE workspace_id = ?`,
    )
      .bind('lifecycle-workspace-1')
      .first<{ teamIds: string; allTeams: number }>()
    expect(JSON.parse(access?.teamIds ?? '[]')).toEqual(['team-1'])
    expect(access?.allTeams).toBe(0)
    await store.applyLifecycleWebhook('linear-delivery-2', Date.now() + 60_000, {
      type: 'revoked',
      workspaceId: 'lifecycle-workspace-1',
    })
    await expect(store.credentialForOwner('lifecycle-owner', 'lifecycle-workspace-1')).rejects.toThrow(
      'Select exactly one',
    )
    await expect(store.credentialForOwner('lifecycle-owner', 'lifecycle-workspace-2')).resolves.toMatchObject({
      workspaceId: 'lifecycle-workspace-2',
    })
  })
})

async function connectWorkspace(
  store: D1LinearConnections,
  ownerSubject: string,
  suffix: string,
  workspaceId: string,
  linearUserId: string,
  expectedExternalSubject: string | null = null,
) {
  const verifier = `linear-pkce-verifier-${suffix}-with-sufficient-entropy`
  const intent = await request(
    `request-${suffix}`,
    `connection-${suffix}`,
    expectedExternalSubject,
    verifier,
    ownerSubject,
  )
  await store.create(intent, `user-state-${suffix}`)
  const userIntent = await store.findByProviderState(`user-state-${suffix}`)
  await store.recordUser(userIntent, humanViewer(linearUserId), `app-state-${suffix}`)
  const appIntent = await store.findByProviderState(`app-state-${suffix}`)
  await store.complete(
    appIntent,
    appViewer(workspaceId, `app-${workspaceId}`),
    token(`access-${suffix}`, `refresh-${suffix}`),
    `code-${suffix}`,
  )
  return store.exchange(`code-${suffix}`, verifier, `request-${suffix}`)
}

async function request(
  jti: string,
  connectionId: string,
  expectedExternalSubject: string | null,
  verifier: string,
  ownerSubject = 'linear-owner',
) {
  return {
    sub: ownerSubject,
    jti,
    state: `realmroot-${jti}`,
    connection_id: connectionId,
    expected_external_subject: expectedExternalSubject,
    owner_type: 'user' as const,
    callback_uri: 'https://id.example/api/account-connections/oauth/callback',
    code_challenge: await sha256Base64Url(verifier),
    code_challenge_method: 'S256' as const,
    scope: 'read write issues:create comments:create app:assignable app:mentionable',
    authorization_details: [],
  }
}

function humanViewer(id: string) {
  return {
    user: { id, name: 'Jasper Van', email: 'jasper@example.com' },
    workspace: { id: 'ignored-workspace', name: 'Ignored', urlKey: 'ignored', logoUrl: null },
  }
}

function appViewer(workspaceId: string, appUserId: string) {
  return {
    user: { id: appUserId, name: 'Realmroot Agent', email: null },
    workspace: { id: workspaceId, name: workspaceId, urlKey: workspaceId, logoUrl: null },
  }
}

function token(accessToken: string, refreshToken: string) {
  return {
    accessToken,
    refreshToken,
    expiresAt: Date.now() + 60_000,
    scopes: ['read', 'write', 'issues:create', 'comments:create', 'app:assignable', 'app:mentionable'] as const,
  }
}
