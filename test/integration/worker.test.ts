import { env, SELF } from 'cloudflare:test'
import { describe, expect, it, vi } from 'vitest'
import { sha256Base64Url } from '../../src/core/digest.js'
import { D1GitHubConnections } from '../../src/storage/d1-github-connections.js'
import { D1RuntimeState } from '../../src/storage/d1-runtime-state.js'

describe('Cloudflare Worker runtime', () => {
  it('serves the adapter through the workerd entrypoint', async () => {
    const response = await SELF.fetch('https://adapter.example/health')
    expect(response.status).toBe(200)
    await expect(response.json()).resolves.toEqual({ status: 'ok' })
  })

  it('persists replay protection, idempotency, and audit state in real D1', async () => {
    const state = new D1RuntimeState(env.DB)
    const proof = { keyThumbprint: 'thumbprint', jti: 'proof-1', now: 1_000, expiresAt: 301_000 }
    await expect(state.claim(proof)).resolves.toBe(true)
    await expect(state.claim(proof)).resolves.toBe(false)

    const operation = vi.fn(async () => Response.json({ id: 1 }, { status: 201 }))
    const first = await state.execute('issue-1', 'agent:repository:create-issue', { title: 'One' }, operation)
    const replay = await state.execute('issue-1', 'agent:repository:create-issue', { title: 'One' }, operation)
    expect(first.status).toBe(201)
    expect(replay.status).toBe(201)
    expect(operation).toHaveBeenCalledOnce()

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
    const connections = new D1GitHubConnections(env.DB)
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
      scope: 'github:metadata:read github:issues:write',
      authorization_details: [{ type: 'github_installation' }],
    }
    await connections.create(request, 'provider-state')
    const intent = await connections.findByProviderState('provider-state', 'pending_oauth')
    await connections.complete(
      intent,
      { id: 7, login: 'controller', name: 'Controller' },
      [
        { id: 101, accountLogin: 'realmroot', targetType: 'Organization' },
        { id: 102, accountLogin: 'controller', targetType: 'User' },
      ],
      'connection-code',
    )
    const result = await connections.exchange('connection-code', verifier, 'request-1')
    expect(result.intent.connectionId).toBe('connection-1')
    expect(result.brokerReference).toBe('connection-1')
    expect(result.contexts.map((context) => context.installationId)).toEqual([101, 102])
    await expect(connections.activeInstallationIdsForOwner('user-1')).resolves.toEqual([101, 102])
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
      [{ id: 103, accountLogin: 'realmroot', targetType: 'Organization' }],
      'connection-code-2',
    )
    const reconnected = await connections.exchange('connection-code-2', verifier, 'request-2')
    expect(reconnected.brokerReference).toBe('connection-1')
    await expect(connections.activeInstallationIdsForOwner('user-1')).resolves.toEqual([103])
    const active = await env.DB.prepare(
      "SELECT COUNT(*) AS count FROM github_connection_binding WHERE owner_subject = ? AND status = 'active'",
    )
      .bind('user-1')
      .first<{ count: number }>()
    expect(active?.count).toBe(1)
  })

  it('[spec: github-adapter/github-provider-revocation] atomically revokes one broker reference and rejects replay', async () => {
    const connections = new D1GitHubConnections(env.DB)
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
      scope: 'github:metadata:read',
      authorization_details: [{ type: 'github_installation' }],
    }
    await connections.create(request, 'provider-state-revoke')
    const intent = await connections.findByProviderState('provider-state-revoke', 'pending_oauth')
    await connections.complete(
      intent,
      { id: 8, login: 'controller', name: 'Controller' },
      [{ id: 201, accountLogin: 'realmroot', targetType: 'Organization' }],
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
    await expect(connections.activeInstallationIdsForOwner('user-revoke')).rejects.toThrow(
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
      [{ id: 202, accountLogin: 'realmroot', targetType: 'Organization' }],
      'connection-code-reconnect',
    )
    await connections.exchange('connection-code-reconnect', verifier, 'request-reconnect')

    await expect(connections.revoke(revocation)).rejects.toThrow('revocation request was already used')
    await expect(connections.activeInstallationIdsForOwner('user-revoke')).resolves.toEqual([202])
  })
})
