import { describe, expect, it, vi } from 'vitest'
import { createApp } from '../../src/app.js'
import { createManagedOpenApiAdapter } from '../../src/core/managed-openapi-adapter.js'
import type { RealmrootAuthenticator } from '../../src/core/realmroot-auth.js'

describe('Managed OpenAPI adapter', () => {
  it('[spec: context7-adapter/context7-library-discovery] forwards only configured operations with sanitized credentials', async () => {
    const upstream = vi.fn(async (_request: string | URL | Request, _init?: RequestInit) =>
      Response.json(
        { results: [{ id: '/honojs/hono', title: 'Hono' }] },
        { headers: { 'x-upstream-request': 'request-1', 'set-cookie': 'secret=cookie' } },
      ),
    )
    const audit = vi.fn(async () => {})
    const app = createApp([
      createManagedOpenApiAdapter(definition(), {
        authenticator: authenticator(['documentation:read']),
        credential: vi.fn(async () => ({
          authorization: 'Bearer upstream-secret',
          scopes: ['documentation:read'],
          actorType: 'oauth_delegated_user',
        })),
        audit,
        fetch: upstream as typeof fetch,
      }),
    ])

    const response = await app.request(
      '/context7/libraries?libraryName=hono&query=middleware',
      { headers: { authorization: 'DPoP agent-secret', dpop: 'proof', cookie: 'session=secret' } },
      { requestId: 'unused' },
    )
    expect(response.status).toBe(200)
    expect(response.headers.get('x-upstream-request')).toBe('request-1')
    expect(response.headers.get('set-cookie')).toBeNull()
    const [url, init] = upstream.mock.calls[0] ?? []
    expect(String(url)).toBe('https://context7.com/api/v2/libs/search?libraryName=hono&query=middleware')
    const headers = new Headers((init as RequestInit).headers)
    expect(headers.get('authorization')).toBe('Bearer upstream-secret')
    expect(headers.has('dpop')).toBe(false)
    expect(headers.has('cookie')).toBe(false)
    expect(audit).toHaveBeenCalledWith(
      expect.objectContaining({
        provider: 'context7',
        operationId: 'listContext7Libraries',
        pathTemplate: '/libraries',
        scope: 'documentation:read',
        result: { status: 200 },
      }),
    )
    expect(JSON.stringify(audit.mock.calls)).not.toContain('middleware')
    expect(JSON.stringify(audit.mock.calls)).not.toContain('upstream-secret')

    const hidden = await app.request('/context7/v2/libs/search')
    expect(hidden.status).toBe(404)
  })

  it('[spec: context7-adapter/context7-contract] publishes RFC 9728 metadata and scope-bearing OpenAPI', async () => {
    const app = createApp([
      createManagedOpenApiAdapter(definition(), {
        authenticator: authenticator(['documentation:read']),
        credential: vi.fn(),
        audit: vi.fn(),
      }),
    ])
    await expect((await app.request('/.well-known/oauth-protected-resource/context7')).json()).resolves.toMatchObject({
      resource: 'https://adapter.example/context7',
      authorization_servers: ['https://adapter.example/oauth/context7'],
      scopes_supported: ['documentation:read'],
      dpop_bound_access_tokens_required: true,
    })
    const resource = await app.request('/context7')
    expect(resource.headers.get('link')).toContain('rel="service-desc"')
    const openapi = await app.request('/context7/openapi.json')
    expect(openapi.headers.get('content-type')).toContain('application/vnd.oai.openapi+json')
  })

  it('returns an insufficient-scope challenge before resolving an upstream credential', async () => {
    const credential = vi.fn()
    const app = createApp([
      createManagedOpenApiAdapter(definition(), {
        authenticator: authenticator([]),
        credential,
        audit: vi.fn(),
      }),
    ])
    const response = await app.request('/context7/libraries?libraryName=hono&query=middleware')
    expect(response.status).toBe(403)
    expect(response.headers.get('www-authenticate')).toContain('documentation:read')
    expect(credential).not.toHaveBeenCalled()
  })
})

function definition() {
  return {
    id: 'context7',
    resource: 'https://adapter.example/context7',
    issuer: 'https://adapter.example/oauth/context7',
    upstreamOrigin: 'https://context7.com/api',
    scopes: { 'documentation:read': 'Read documentation.' },
    operations: [
      {
        operationId: 'listContext7Libraries',
        method: 'GET',
        path: '/libraries',
        upstreamPath: '/v2/libs/search',
        scopes: ['documentation:read'],
      },
    ],
    openapi: { openapi: '3.1.0' },
    manifest: { provider: 'context7' },
  } as const
}

function authenticator(scopes: string[]): RealmrootAuthenticator {
  return {
    authenticate: vi.fn(async () => ({
      subject: 'context7-user-1',
      issuer: 'https://adapter.example/oauth/context7',
      actor: { issuer: 'https://id.example/api/auth', subject: 'agent-1', profile: 'ai_agent' as const },
      scopes: new Set(scopes),
      connectionId: 'connection-1',
      authorizationDetails: [],
    })),
  }
}
