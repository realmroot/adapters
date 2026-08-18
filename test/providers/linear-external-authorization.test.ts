import { describe, expect, it, vi } from 'vitest'
import type { ExternalOAuthIntent } from '../../src/core/external-oauth-store.js'
import type { D1LinearConnections } from '../../src/providers/linear/connections.js'
import { createLinearExternalAuthorization } from '../../src/providers/linear/external-authorization.js'
import type { LinearProvider, LinearToken, LinearViewer } from '../../src/providers/linear/types.js'

describe('Linear external authorization', () => {
  it('[spec: linear-adapter/linear-provider-connection] exposes the Linear user as the stable Provider Connection subject', async () => {
    const token: LinearToken = {
      accessToken: 'linear-access',
      refreshToken: 'linear-refresh',
      expiresAt: Date.now() + 60_000,
      scopes: ['read'],
    }
    const viewer: LinearViewer = {
      user: { id: 'linear-user-1', name: 'Jasper', email: 'jasper@example.com' },
      workspace: { id: 'workspace-1', name: 'Realmroot', urlKey: 'realmroot', logoUrl: null },
    }
    const provider = {
      exchangeCode: vi.fn(async () => token),
      viewer: vi.fn(async () => viewer),
    } as unknown as LinearProvider
    const connections = {
      upsertExternalAuthorization: vi.fn(async () => [
        {
          workspaceId: viewer.workspace.id,
          workspaceName: viewer.workspace.name,
          workspaceUrlKey: viewer.workspace.urlKey,
          appUserId: 'linear-app-user-1',
        },
      ]),
    } as unknown as D1LinearConnections
    const authorization = createLinearExternalAuthorization({
      origin: 'https://adapter.example',
      provider,
      connections,
      scopes: ['read'],
    })
    const intent: ExternalOAuthIntent = {
      id: 'intent-1',
      providerId: 'linear',
      clientId: 'realmroot',
      redirectUri: 'https://id.example/callback',
      realmrootState: 'realmroot-state',
      scopes: ['openid', 'offline_access', 'read'],
      authorizationDetails: [],
      codeChallenge: 'challenge',
      providerStage: 'app',
      providerData: { linearUser: viewer.user, requestedScopes: ['read'] },
      expiresAt: Date.now() + 60_000,
    }

    await expect(
      authorization.complete({
        callbackUrl: 'https://adapter.example/linear/oauth/callback?code=linear-code',
        intent,
        nextProviderState: () => 'unused',
      }),
    ).resolves.toMatchObject({
      type: 'complete',
      grant: {
        subject: 'linear-user-1',
        displayName: 'Jasper',
      },
    })
  })
})
