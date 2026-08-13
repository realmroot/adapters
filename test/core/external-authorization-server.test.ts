import { exportJWK, generateKeyPair } from 'jose'
import { describe, expect, it, vi } from 'vitest'
import { createApp } from '../../src/app.js'
import {
  createExternalAuthorizationServer,
  type ExternalProviderAuthorization,
} from '../../src/core/external-authorization-server.js'
import { type D1ExternalOAuthStore, type ExternalOAuthIntent, sha256 } from '../../src/core/external-oauth-store.js'

describe('external authorization server', () => {
  it('publishes the standard OAuth surface for one provider', async () => {
    const { app } = await testServer()

    const response = await app.request('/.well-known/oauth-authorization-server/oauth/example')

    expect(response.status).toBe(200)
    await expect(response.json()).resolves.toMatchObject({
      issuer: 'https://adapter.example/oauth/example',
      authorization_endpoint: 'https://adapter.example/oauth/example/authorize',
      token_endpoint: 'https://adapter.example/oauth/example/token',
      registration_endpoint: 'https://adapter.example/oauth/example/register',
      userinfo_endpoint: 'https://adapter.example/oauth/example/userinfo',
      grant_types_supported: expect.arrayContaining([
        'authorization_code',
        'refresh_token',
        'urn:ietf:params:oauth:grant-type:jwt-bearer',
        'urn:ietf:params:oauth:grant-type:token-exchange',
      ]),
      code_challenge_methods_supported: ['S256'],
      dpop_signing_alg_values_supported: ['ES256'],
      authorization_details_types_supported: ['example_context'],
      authorization_details_catalog_endpoint: 'https://adapter.example/oauth/example/authorization-details',
      authorization_details_catalog_scope: 'authorization-details:read',
      authorization_details_catalog_version: 1,
    })
  })

  it('serves the provider catalog to a connected subject token', async () => {
    const { app, provider } = await testServer()
    const tokenResponse = await app.request('/oauth/example/token', {
      method: 'POST',
      headers: {
        authorization: `Basic ${btoa('client-1:secret')}`,
        'content-type': 'application/x-www-form-urlencoded',
      },
      body: new URLSearchParams({
        grant_type: 'authorization_code',
        code: 'code-1',
        redirect_uri: 'https://id.realmroot.dev/callback',
        code_verifier: 'verifier',
      }),
    })
    expect(tokenResponse.status).toBe(200)
    const token = (await tokenResponse.json()) as { access_token: string }

    const response = await app.request('/oauth/example/authorization-details?limit=10&offset=0', {
      headers: { authorization: `Bearer ${token.access_token}` },
    })

    expect(response.status).toBe(200)
    await expect(response.json()).resolves.toMatchObject({
      items: [
        {
          authorizationDetail: { type: 'example_context', project_id: 'project-1' },
          display: { label: 'Project One' },
        },
      ],
      pagination: { limit: 10, offset: 0, total: 1, hasMore: false, nextOffset: null },
    })
    expect(provider.authorizationDetailsCatalog?.list).toHaveBeenCalledWith({
      subject: 'provider-user-1',
      limit: 10,
      offset: 0,
    })
  })

  it('registers a provider-scoped client with all required grants', async () => {
    const { app, store } = await testServer()

    const response = await app.request('/oauth/example/register', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        redirect_uris: ['https://id.realmroot.dev/api/account-connections/oauth/callback'],
        jwks_uri: 'https://id.realmroot.dev/api/auth/jwks',
        grant_types: [
          'authorization_code',
          'refresh_token',
          'urn:ietf:params:oauth:grant-type:jwt-bearer',
          'urn:ietf:params:oauth:grant-type:token-exchange',
        ],
      }),
    })

    expect(response.status).toBe(201)
    const client = (await response.json()) as { client_id: string; client_secret: string }
    expect(client.client_id).toMatch(/^client_/)
    expect(client.client_secret).toMatch(/^secret_/)
    expect(store.registerClient).toHaveBeenCalledWith(
      expect.objectContaining({
        clientId: client.client_id,
        providerId: 'example',
        redirectUris: ['https://id.realmroot.dev/api/account-connections/oauth/callback'],
        jwksUri: 'https://id.realmroot.dev/api/auth/jwks',
        clientSecretHash: expect.any(String),
      }),
    )
  })

  it('rejects unsupported scopes before starting provider authorization', async () => {
    const { app, provider } = await testServer()
    const response = await app.request(
      '/oauth/example/authorize?response_type=code&client_id=client-1&redirect_uri=https%3A%2F%2Fid.realmroot.dev%2Fcallback&scope=unknown&state=state-1&code_challenge=challenge&code_challenge_method=S256',
    )

    expect(response.status).toBe(400)
    await expect(response.json()).resolves.toMatchObject({ error: 'invalid_scope' })
    expect(provider.begin).not.toHaveBeenCalled()
  })

  it('keeps provider-specific authorization behind the standard authorization endpoint', async () => {
    const { app, provider, store } = await testServer()
    const details = encodeURIComponent(JSON.stringify([{ type: 'example_context', project_id: 'project-1' }]))

    const response = await app.request(
      `/oauth/example/authorize?response_type=code&client_id=client-1&redirect_uri=https%3A%2F%2Fid.realmroot.dev%2Fcallback&scope=openid+items%3Aread&state=state-1&code_challenge=challenge&code_challenge_method=S256&authorization_details=${details}`,
    )

    expect(response.status).toBe(302)
    expect(response.headers.get('location')).toMatch(/^https:\/\/provider\.example\/authorize\?state=state_/)
    expect(provider.begin).toHaveBeenCalledWith({
      providerState: expect.stringMatching(/^state_/),
      scopes: ['items:read', 'openid'],
      authorizationDetails: [{ type: 'example_context', project_id: 'project-1' }],
    })
    expect(store.createIntent).toHaveBeenCalledWith(
      expect.objectContaining({
        providerId: 'example',
        clientId: 'client-1',
        realmrootState: 'state-1',
        providerStage: 'provider',
      }),
      expect.any(String),
    )
  })

  it('returns a one-time authorization code to Realmroot after provider completion', async () => {
    const intent = exampleIntent()
    const { app, store } = await testServer({ intent })

    const response = await app.request('/oauth/example/provider/callback?state=provider-state&code=provider-code')

    expect(response.status).toBe(302)
    const location = response.headers.get('location')
    expect(location).not.toBeNull()
    const callback = new URL(location ?? '')
    expect(callback.origin + callback.pathname).toBe('https://id.realmroot.dev/callback')
    expect(callback.searchParams.get('state')).toBe('realmroot-state')
    expect(callback.searchParams.get('code')).toMatch(/^code_/)
    expect(store.completeIntent).toHaveBeenCalledWith(
      intent,
      {
        providerId: 'example',
        clientId: 'client-1',
        subject: 'provider-user-1',
        displayName: 'Provider User',
        scopes: ['items:read', 'openid'],
        authorizationDetails: [{ type: 'example_context', project_id: 'project-1' }],
      },
      callback.searchParams.get('code'),
    )
  })

  it('supports a provider callback path already registered with the upstream OAuth application', async () => {
    const intent = exampleIntent()
    const { app, store } = await testServer({ intent, providerCallbackPath: '/example/oauth/callback' })

    const oldPath = await app.request('/oauth/example/provider/callback?state=provider-state&code=provider-code')
    expect(oldPath.status).toBe(404)

    const response = await app.request('/example/oauth/callback?state=provider-state&code=provider-code')
    expect(response.status).toBe(302)
    expect(store.completeIntent).toHaveBeenCalledWith(intent, expect.any(Object), expect.stringMatching(/^code_/))
  })
})

async function testServer(options: { intent?: ExternalOAuthIntent; providerCallbackPath?: string } = {}) {
  const store = {
    registerClient: vi.fn(async () => undefined),
    client: vi.fn(async (_providerId: string, clientId: string) => ({
      clientId,
      providerId: 'example',
      clientSecretHash: await sha256('secret'),
      redirectUris: ['https://id.realmroot.dev/callback'],
      jwksUri: 'https://id.realmroot.dev/api/auth/jwks',
    })),
    createIntent: vi.fn(async () => undefined),
    intentByProviderState: vi.fn(async () => options.intent ?? exampleIntent()),
    advanceIntent: vi.fn(async () => undefined),
    completeIntent: vi.fn(async () => undefined),
    consumeCode: vi.fn(async () => ({
      providerId: 'example',
      clientId: 'client-1',
      subject: 'provider-user-1',
      displayName: 'Provider User',
      scopes: ['authorization-details:read', 'items:read', 'openid'],
      authorizationDetails: [{ type: 'example_context', project_id: 'project-1' }],
    })),
    createRefresh: vi.fn(async () => undefined),
  }
  const provider: ExternalProviderAuthorization = {
    id: 'example',
    resource: 'https://adapter.example/example',
    scopes: ['openid', 'offline_access', 'authorization-details:read', 'items:read'],
    authorizationDetailsTypes: ['example_context'],
    authorizationDetailsCatalog: {
      scope: 'authorization-details:read',
      list: vi.fn(async ({ limit, offset }) => ({
        items: [
          {
            authorizationDetail: { type: 'example_context', project_id: 'project-1' },
            display: { label: 'Project One' },
          },
        ],
        pagination: { limit, offset, total: 1, hasMore: false, nextOffset: null },
      })),
    },
    begin: vi.fn(({ providerState }) => ({
      url: `https://provider.example/authorize?state=${providerState}`,
      stage: 'provider',
    })),
    complete: vi.fn(async ({ intent }) => ({
      type: 'complete' as const,
      grant: {
        subject: 'provider-user-1',
        displayName: 'Provider User',
        scopes: intent.scopes,
        authorizationDetails: intent.authorizationDetails,
      },
    })),
  }
  const { privateKey } = await generateKeyPair('ES256', { extractable: true })
  const signingPrivateJwk = await exportJWK(privateKey)
  const server = await createExternalAuthorizationServer({
    origin: 'https://adapter.example',
    provider,
    ...(options.providerCallbackPath ? { providerCallbackPath: options.providerCallbackPath } : {}),
    store: store as unknown as D1ExternalOAuthStore,
    signingPrivateJwk,
    replayStore: { claim: vi.fn(async () => true) },
  })
  const app = createApp([server])
  return { app, provider, store }
}

function exampleIntent(): ExternalOAuthIntent {
  return {
    id: 'intent-1',
    providerId: 'example',
    clientId: 'client-1',
    redirectUri: 'https://id.realmroot.dev/callback',
    realmrootState: 'realmroot-state',
    scopes: ['items:read', 'openid'],
    authorizationDetails: [{ type: 'example_context', project_id: 'project-1' }],
    codeChallenge: 'challenge',
    providerStage: 'provider',
    providerData: {},
    expiresAt: Date.now() + 60_000,
  }
}
