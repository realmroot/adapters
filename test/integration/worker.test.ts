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

  it('stores one GitHub connection with multiple installation contexts and consumes PKCE once', async () => {
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
    const result = await connections.exchange('connection-code', verifier)
    expect(result.intent.connectionId).toBe('connection-1')
    expect(result.contexts.map((context) => context.installationId)).toEqual([101, 102])
    await expect(connections.activeInstallationIds('connection-1')).resolves.toEqual([101, 102])
    await expect(connections.exchange('connection-code', verifier)).rejects.toThrow('Connection code is invalid')
  })
})
