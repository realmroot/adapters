import { describe, expect, it, vi } from 'vitest'
import type { ExternalOAuthIntent } from '../../src/core/external-oauth-store.js'
import type { ManagedOAuthClient, ManagedOAuthCredentials } from '../../src/core/managed-oauth.js'
import { createTodoistExternalAuthorization } from '../../src/providers/todoist/oauth.js'

describe('Todoist external authorization', () => {
  it('[spec: todoist-adapter/todoist-provider-oauth] resolves identity and supports local-only revocation', async () => {
    const provider: ManagedOAuthClient = {
      authorizationUrl: vi.fn(async () => ({ url: 'https://app.todoist.com/oauth/authorize', verifier: 'verifier' })),
      exchangeCode: vi.fn(async () => ({
        accessToken: 'todoist-access',
        refreshToken: 'todoist-refresh',
        expiresAt: Date.now() + 60_000,
        scopes: ['data:read'],
      })),
      refresh: vi.fn(),
      userInfo: vi.fn(async () => ({ id: 'todoist-user-1', full_name: 'Todo User' })),
    }
    const credentials: ManagedOAuthCredentials = {
      sealVerifier: vi.fn(async (value) => `sealed:${value}`),
      openVerifier: vi.fn(async () => 'verifier'),
      upsert: vi.fn(async () => {}),
      credential: vi.fn(async () => ({
        subject: 'todoist-user-1',
        displayName: 'Todo User',
        accessToken: 'todoist-access',
        refreshToken: 'todoist-refresh',
        expiresAt: Date.now() + 60_000,
        providerScopes: ['data:read'],
        credentialVersion: 1,
      })),
      replace: vi.fn(async () => true),
      revoke: vi.fn(async () => {}),
    }
    const authorization = createTodoistExternalAuthorization({
      origin: 'https://adapter.example',
      provider,
      credentials,
    })
    const intent: ExternalOAuthIntent = {
      id: 'intent-1',
      providerId: 'todoist',
      clientId: 'realmroot',
      redirectUri: 'https://id.example/callback',
      realmrootState: 'realmroot-state',
      scopes: ['openid', 'offline_access', 'tasks:read'],
      authorizationDetails: [],
      codeChallenge: 'challenge',
      providerStage: 'provider',
      providerData: { verifier: 'sealed:verifier' },
      expiresAt: Date.now() + 60_000,
    }

    await expect(
      authorization.complete({
        callbackUrl: 'https://adapter.example/oauth/todoist/provider/callback?code=todoist-code',
        intent,
        nextProviderState: () => 'unused',
      }),
    ).resolves.toMatchObject({
      type: 'complete',
      grant: { subject: 'todoist-user-1', displayName: 'Todo User', scopes: intent.scopes },
    })
    expect(credentials.upsert).toHaveBeenCalledWith(
      { subject: 'todoist-user-1', displayName: 'Todo User' },
      expect.objectContaining({ accessToken: 'todoist-access' }),
    )

    await authorization.revoke?.('todoist-user-1')
    expect(credentials.revoke).toHaveBeenCalledWith('todoist-user-1')
  })
})
