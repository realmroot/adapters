import { env } from 'cloudflare:test'
import { describe, expect, it } from 'vitest'
import { D1ExternalOAuthStore, type ExternalOAuthIntent, sha256 } from '../../src/core/external-oauth-store.js'

describe('External OAuth intent persistence', () => {
  it('[spec: github-adapter/github-installation-permission-upgrade] consumes a denied authorization intent once', async () => {
    const store = new D1ExternalOAuthStore(env.DB)
    const intent: ExternalOAuthIntent = {
      id: 'github-permission-update-denied',
      providerId: 'github',
      clientId: 'github-permission-update-client',
      redirectUri: 'https://id.realmroot.dev/oauth/account-connection/callback',
      realmrootState: 'realmroot-state',
      scopes: ['administration:write', 'openid'],
      authorizationDetails: [],
      codeChallenge: 'challenge',
      providerStage: 'oauth-selected',
      providerData: { expectedInstallationId: 701, permissionUpdateAttempted: true },
      expiresAt: Date.now() + 60_000,
    }
    await store.registerClient({
      clientId: intent.clientId,
      providerId: 'github',
      clientSecretHash: await sha256('secret'),
      redirectUris: [intent.redirectUri],
      jwksUri: 'https://id.realmroot.dev/api/auth/jwks',
    })
    await store.createIntent(intent, await sha256('provider-state'))

    await store.cancelIntent(intent)

    await expect(store.intentByProviderState(await sha256('provider-state'))).rejects.toThrow(
      'External OAuth state is invalid or expired.',
    )
    await expect(store.cancelIntent(intent)).rejects.toThrow('External OAuth authorization was already completed.')
  })
})
