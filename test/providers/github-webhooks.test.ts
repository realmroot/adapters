import { createHmac } from 'node:crypto'
import { describe, expect, it, vi } from 'vitest'
import type { ConnectionEventSink } from '../../src/core/connection-events.js'
import type { GitHubConnectionStore } from '../../src/providers/github/connections.js'
import { handleGitHubWebhook } from '../../src/providers/github/webhooks.js'

const secret = 'github-webhook-secret'

describe('GitHub lifecycle webhooks', () => {
  it('[spec: github-adapter/github-installation-lifecycle] verifies signatures before changing context', async () => {
    const connections = lifecycleStore()
    const events = eventSink()
    const request = webhookRequest('installation', 'delivery-1', {
      action: 'suspend',
      installation: { id: 42 },
    })
    request.headers.set('X-Hub-Signature-256', 'sha256='.padEnd(71, '0'))

    await expect(handleGitHubWebhook({ request, secret, connections, events })).rejects.toThrow(
      'signature is missing or invalid',
    )
    expect(connections.prepareLifecycleEvent).not.toHaveBeenCalled()
    expect(events.send).not.toHaveBeenCalled()
  })

  it('[spec: github-adapter/github-installation-lifecycle] translates permission acceptance into authority changed', async () => {
    const connections = lifecycleStore({
      event: {
        id: 'delivery-2',
        type: 'authorityChanged',
        brokerReference: 'broker-1',
        occurredAt: '2027-01-15T08:00:00.000Z',
        revision: 1,
        scopes: ['issues:read', 'issues:write', 'metadata:read'],
        affectedScopes: ['issues:read', 'issues:write', 'metadata:read'],
        affectedAuthorizationDetails: [{ type: 'github_installation', installation_id: '42' }],
        authorityConstraints: [
          {
            authorizationDetails: [{ type: 'github_installation', installation_id: '42' }],
            scopes: ['issues:read', 'issues:write', 'metadata:read'],
          },
        ],
      },
      completed: false,
    })
    const events = eventSink()

    await handleGitHubWebhook({
      request: webhookRequest('installation', 'delivery-2', {
        action: 'new_permissions_accepted',
        installation: {
          id: 42,
          permissions: { metadata: 'read', issues: 'write' },
          updated_at: '2027-01-15T08:00:00.000Z',
        },
      }),
      secret,
      connections,
      events,
    })

    expect(connections.prepareLifecycleEvent).toHaveBeenCalledWith({
      deliveryId: 'delivery-2',
      fingerprint: expect.stringMatching(/^[0-9a-f]{64}$/),
      type: 'authorityChanged',
      installationId: 42,
      occurredAt: '2027-01-15T08:00:00.000Z',
      providerUpdatedAt: Date.parse('2027-01-15T08:00:00.000Z'),
      scopes: ['issues:read', 'issues:write', 'metadata:read'],
    })
    expect(events.send).toHaveBeenCalledOnce()
    expect(connections.completeLifecycleEvent).toHaveBeenCalledWith('delivery-2')
  })

  it('[spec: github-adapter/github-installation-lifecycle] accepts offset lifecycle timestamps', async () => {
    const connections = lifecycleStore()

    await handleGitHubWebhook({
      request: webhookRequest('installation', 'delivery-offset', {
        action: 'suspend',
        installation: {
          id: 42,
          updated_at: '2027-01-15T08:00:00+00:00',
          suspended_at: '2027-01-15T08:01:00+00:00',
        },
      }),
      secret,
      connections,
      events: eventSink(),
    })

    expect(connections.prepareLifecycleEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        type: 'suspended',
        occurredAt: '2027-01-15T08:01:00+00:00',
        providerUpdatedAt: Date.parse('2027-01-15T08:01:00+00:00'),
      }),
    )
  })

  it('[spec: github-adapter/github-installation-resources] leaves an already completed delivery idempotent', async () => {
    const connections = lifecycleStore({
      event: {
        id: 'delivery-3',
        type: 'resourcesChanged',
        brokerReference: 'broker-1',
        occurredAt: '2027-01-15T08:00:00.000Z',
        revision: 1,
        scopes: ['metadata:read'],
        authorizationDetails: [{ type: 'github_installation', installation_id: '42' }],
        authorityConstraints: [
          {
            authorizationDetails: [{ type: 'github_installation', installation_id: '42' }],
            scopes: ['metadata:read'],
          },
        ],
      },
      completed: true,
    })
    const events = eventSink()

    await handleGitHubWebhook({
      request: webhookRequest('installation_repositories', 'delivery-3', {
        action: 'removed',
        installation: { id: 42, updated_at: '2027-01-15T08:00:00.000Z' },
        repository_selection: 'selected',
        repositories_added: [],
        repositories_removed: [{ id: 7, full_name: 'realmroot/removed' }],
      }),
      secret,
      connections,
      events,
    })

    expect(events.send).not.toHaveBeenCalled()
    expect(connections.completeLifecycleEvent).not.toHaveBeenCalled()
  })

  it('verifies but ignores unrelated GitHub event types', async () => {
    const connections = lifecycleStore()
    const events = eventSink()

    await handleGitHubWebhook({
      request: webhookRequest('issues', 'delivery-4', { action: 'opened' }),
      secret,
      connections,
      events,
    })

    expect(connections.prepareLifecycleEvent).not.toHaveBeenCalled()
    expect(events.send).not.toHaveBeenCalled()
  })

  it('ignores unsupported installation actions after signature verification', async () => {
    const connections = lifecycleStore()
    const events = eventSink()

    await handleGitHubWebhook({
      request: webhookRequest('installation', 'delivery-5', { action: 'created', installation: { id: 42 } }),
      secret,
      connections,
      events,
    })

    expect(connections.prepareLifecycleEvent).not.toHaveBeenCalled()
    expect(events.send).not.toHaveBeenCalled()
  })

  it('rejects malformed supported lifecycle payloads at the HTTP boundary', async () => {
    const connections = lifecycleStore()
    const events = eventSink()
    const body = '{invalid'
    const request = new Request('https://adapter.example/github/webhooks', {
      method: 'POST',
      headers: {
        'X-GitHub-Delivery': 'delivery-6',
        'X-GitHub-Event': 'installation',
        'X-Hub-Signature-256': `sha256=${createHmac('sha256', secret).update(body).digest('hex')}`,
      },
      body,
    })

    await expect(handleGitHubWebhook({ request, secret, connections, events })).rejects.toThrow('not valid JSON')
    expect(connections.prepareLifecycleEvent).not.toHaveBeenCalled()
  })

  it('[spec: github-adapter/github-installation-lifecycle] rejects oversized bodies before signature verification', async () => {
    const connections = lifecycleStore()
    const events = eventSink()
    const body = 'x'.repeat(1024 * 1024 + 1)
    const request = new Request('https://adapter.example/github/webhooks', {
      method: 'POST',
      headers: {
        'X-GitHub-Delivery': 'delivery-7',
        'X-GitHub-Event': 'installation',
        'X-Hub-Signature-256': 'sha256=invalid',
      },
      body,
    })

    await expect(handleGitHubWebhook({ request, secret, connections, events })).rejects.toThrow('exceeds 1048576 bytes')
    expect(connections.prepareLifecycleEvent).not.toHaveBeenCalled()
  })
})

function webhookRequest(event: string, delivery: string, payload: unknown) {
  const body = JSON.stringify(payload)
  return new Request('https://adapter.example/github/webhooks', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-GitHub-Delivery': delivery,
      'X-GitHub-Event': event,
      'X-Hub-Signature-256': `sha256=${createHmac('sha256', secret).update(body).digest('hex')}`,
    },
    body,
  })
}

function lifecycleStore(
  prepared: Awaited<ReturnType<GitHubConnectionStore['prepareLifecycleEvent']>> = { event: null, completed: true },
) {
  return {
    prepareLifecycleEvent: vi.fn(async () => prepared),
    completeLifecycleEvent: vi.fn(async () => {}),
  } as unknown as GitHubConnectionStore & {
    prepareLifecycleEvent: ReturnType<typeof vi.fn<GitHubConnectionStore['prepareLifecycleEvent']>>
    completeLifecycleEvent: ReturnType<typeof vi.fn<GitHubConnectionStore['completeLifecycleEvent']>>
  }
}

function eventSink() {
  return { send: vi.fn(async () => {}) } satisfies ConnectionEventSink
}
