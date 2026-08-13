import { createHmac } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import { createLinearCredentialCipher } from '../../src/providers/linear/credentials.js'
import { verifyLinearWebhook } from '../../src/providers/linear/webhooks.js'

describe('Linear credential and webhook security', () => {
  it('[spec: linear-adapter/linear-provider-connection] seals credentials with context-bound AES-GCM', async () => {
    const cipher = createLinearCredentialCipher('AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA')
    const sealed = await cipher.seal('provider-secret', 'linear:connection-1:workspace-1:access')
    expect(sealed).not.toContain('provider-secret')
    await expect(cipher.open(sealed, 'linear:connection-1:workspace-1:access')).resolves.toBe('provider-secret')
    await expect(cipher.open(sealed, 'linear:connection-1:workspace-2:access')).rejects.toThrow()
  })

  it('[spec: linear-adapter/linear-provider-lifecycle] verifies signature, timestamp, client, and delivery', async () => {
    const now = 1_700_000_000_000
    const payload = JSON.stringify({
      type: 'PermissionChange',
      action: 'teamAccessChanged',
      organizationId: 'workspace-1',
      oauthClientId: 'client-1',
      appUserId: 'app-user-1',
      canAccessAllPublicTeams: false,
      addedTeamIds: ['team-1'],
      removedTeamIds: [],
      webhookTimestamp: now,
      webhookId: 'delivery-1',
    })
    const signature = createHmac('sha256', 'webhook-secret').update(payload).digest('hex')
    const request = () =>
      new Request('https://adapter.example/linear/webhooks', {
        method: 'POST',
        headers: {
          'linear-signature': signature,
          'linear-timestamp': String(now),
          'linear-delivery': 'delivery-1',
        },
        body: payload,
      })
    await expect(
      verifyLinearWebhook({ request: request(), secret: 'webhook-secret', clientId: 'client-1', now }),
    ).resolves.toMatchObject({ deliveryId: 'delivery-1' })
    await expect(
      verifyLinearWebhook({ request: request(), secret: 'wrong-secret', clientId: 'client-1', now }),
    ).rejects.toThrow('signature')
    await expect(
      verifyLinearWebhook({ request: request(), secret: 'webhook-secret', clientId: 'other-client', now }),
    ).rejects.toThrow('OAuth client')
  })
})
