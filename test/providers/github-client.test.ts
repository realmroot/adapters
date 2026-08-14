import { generateKeyPairSync } from 'node:crypto'
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { createGitHubConnectionProvider, createGitHubProvider } from '../../src/providers/github/client.js'

type SeenRequest = { method: string; url: string; authorization: string | undefined; body: unknown }
let closeServer: (() => Promise<void>) | undefined

afterEach(async () => {
  await closeServer?.()
  closeServer = undefined
})

describe('GitHub provider HTTP boundary', () => {
  let apiOrigin: string
  let seen: SeenRequest[]

  beforeEach(async () => {
    seen = []
    const server = createServer(async (request, response) => route(request, response, seen))
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
    const address = server.address()
    if (!address || typeof address === 'string') throw new Error('Test server did not bind a TCP port.')
    apiOrigin = `http://127.0.0.1:${address.port}`
    closeServer = () => new Promise((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())))
  })

  it('reads App permissions, mints a downscoped token, and transparently forwards GitHub HTTP', async () => {
    const provider = createGitHubProvider({
      appId: '123',
      privateKey: privateKey('pkcs8'),
      apiOrigin,
      now: () => 1_800_000_000_000,
    })

    await expect(provider.appPermissions()).resolves.toEqual({ metadata: 'read', issues: 'write' })
    await expect(provider.appPermissions()).resolves.toEqual({ metadata: 'read', issues: 'write' })
    const token = await provider.installationToken({
      installationId: 42,
      permissions: { issues: 'write' },
      repositories: ['example'],
    })
    const response = await provider.request(
      new Request(`${apiOrigin}/repos/realmroot/example/issues?mode=raw`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Accept: 'application/vnd.github+json' },
        body: JSON.stringify({ title: 'Hello', body: 'Body' }),
      }),
      token,
    )

    expect(response.status).toBe(201)
    expect(response.headers.get('x-github-request-id')).toBe('request-1')
    expect(seen.filter((request) => request.url === '/app')).toHaveLength(1)
    expect(seen.find((request) => request.url === '/app/installations/42/access_tokens')?.body).toEqual({
      permissions: { issues: 'write' },
      repositories: ['example'],
    })
    expect(seen.at(-1)).toMatchObject({
      method: 'POST',
      url: '/repos/realmroot/example/issues?mode=raw',
      authorization: 'Bearer installation-token',
      body: { title: 'Hello', body: 'Body' },
    })
  })

  it('accepts the PKCS#1 private keys downloaded from GitHub App settings', async () => {
    const provider = createGitHubProvider({
      appId: '123',
      privateKey: privateKey('pkcs1'),
      apiOrigin,
      now: () => 1_800_000_000_000,
    })
    await expect(provider.appPermissions()).resolves.toEqual({ metadata: 'read', issues: 'write' })
  })

  it('reuses Cloudflare Cache API App permissions across provider instances', async () => {
    const responses = new Map<string, Response>()
    const cache = {
      match: async (request: RequestInfo | URL) => responses.get(String(request))?.clone(),
      put: async (request: RequestInfo | URL, response: Response) => {
        responses.set(String(request), response.clone())
      },
    } as Cache
    const input = {
      appId: '123',
      privateKey: privateKey('pkcs8'),
      apiOrigin,
      cache,
      now: () => 1_800_000_000_000,
    }

    await createGitHubProvider(input).appPermissions()
    await createGitHubProvider(input).appPermissions()

    expect(seen.filter((request) => request.url === '/app')).toHaveLength(1)
  })
})

describe('GitHub account connection OAuth boundary', () => {
  it('selects the adapter callback when the GitHub App has multiple callback URLs', async () => {
    const requests: Array<{ url: string; body: unknown }> = []
    const provider = createGitHubConnectionProvider({
      appId: '123',
      privateKey: privateKey('pkcs8'),
      clientId: 'client-id',
      clientSecret: 'client-secret',
      redirectUri: 'https://adapters.realmroot.dev/github/oauth/callback',
      apiOrigin: 'https://api.github.test',
      fetcher: async (input, init) => {
        requests.push({ url: String(input), body: init?.body ? JSON.parse(String(init.body)) : undefined })
        return Response.json({ access_token: 'user-token' })
      },
    })

    const authorization = new URL(provider.authorizationUrl('provider-state'))
    expect(authorization.searchParams.get('redirect_uri')).toBe('https://adapters.realmroot.dev/github/oauth/callback')
    await expect(provider.exchangeUserCode('authorization-code')).resolves.toBe('user-token')
    expect(requests[0]).toEqual({
      url: 'https://github.com/login/oauth/access_token',
      body: {
        client_id: 'client-id',
        client_secret: 'client-secret',
        code: 'authorization-code',
        redirect_uri: 'https://adapters.realmroot.dev/github/oauth/callback',
      },
    })
    expect(provider.permissionUpdateUrl({ htmlUrl: 'https://github.com/settings/installations/42' } as never)).toBe(
      'https://github.com/settings/installations/42/permissions/update',
    )
  })

  it('loads selected repository membership with the installation context', async () => {
    const requests: string[] = []
    const provider = createGitHubConnectionProvider({
      appId: '123',
      privateKey: privateKey('pkcs8'),
      clientId: 'client-id',
      clientSecret: 'client-secret',
      redirectUri: 'https://adapters.realmroot.dev/github/oauth/callback',
      apiOrigin: 'https://api.github.test',
      fetcher: async (input) => {
        const url = String(input)
        requests.push(url)
        if (url.endsWith('/user/installations?per_page=100')) {
          return Response.json({
            installations: [
              {
                id: 42,
                html_url: 'https://github.com/organizations/realmroot/settings/installations/42',
                account: { login: 'realmroot' },
                target_type: 'Organization',
                permissions: { metadata: 'read' },
                repository_selection: 'selected',
                updated_at: '2027-01-15T08:00:00+00:00',
              },
            ],
          })
        }
        if (url.endsWith('/user/installations/42/repositories?per_page=100')) {
          return Response.json({
            total_count: 101,
            repositories: Array.from({ length: 100 }, (_, index) => ({
              id: index + 1,
              full_name: `realmroot/repository-${index + 1}`,
            })),
          })
        }
        if (url.endsWith('/user/installations/42/repositories?per_page=100&page=2')) {
          return Response.json({
            total_count: 101,
            repositories: [{ id: 101, full_name: 'realmroot/repository-101' }],
          })
        }
        return Response.json({ message: 'not found' }, { status: 404 })
      },
    })

    const installations = await provider.listUserInstallations('user-token')
    expect(installations).toHaveLength(1)
    expect(installations[0]).toMatchObject({
      id: 42,
      htmlUrl: 'https://github.com/organizations/realmroot/settings/installations/42',
      accountLogin: 'realmroot',
      targetType: 'Organization',
      permissions: { metadata: 'read' },
      repositorySelection: 'selected',
      updatedAt: '2027-01-15T08:00:00+00:00',
    })
    expect(installations[0]?.repositories).toHaveLength(101)
    expect(installations[0]?.repositories.at(-1)).toEqual({ id: 101, fullName: 'realmroot/repository-101' })
    expect(requests).toEqual([
      'https://api.github.test/user/installations?per_page=100',
      'https://api.github.test/user/installations/42/repositories?per_page=100',
      'https://api.github.test/user/installations/42/repositories?per_page=100&page=2',
    ])
  })
})

async function route(request: IncomingMessage, response: ServerResponse, seen: SeenRequest[]) {
  const chunks: Buffer[] = []
  for await (const chunk of request) chunks.push(Buffer.from(chunk))
  const text = Buffer.concat(chunks).toString()
  seen.push({
    method: request.method ?? 'GET',
    url: request.url ?? '/',
    authorization: request.headers.authorization,
    body: text ? JSON.parse(text) : undefined,
  })
  response.setHeader('content-type', 'application/json')
  if (request.url === '/app') {
    response.end(JSON.stringify({ slug: 'realmroot', permissions: { metadata: 'read', issues: 'write' } }))
    return
  }
  if (request.url === '/app/installations/42/access_tokens') {
    response.statusCode = 201
    response.end(JSON.stringify({ token: 'installation-token', expires_at: '2030-01-01T00:00:00Z' }))
    return
  }
  if (request.url === '/repos/realmroot/example/issues?mode=raw') {
    response.statusCode = 201
    response.setHeader('x-github-request-id', 'request-1')
    response.end(JSON.stringify({ id: 700, number: 7 }))
    return
  }
  response.statusCode = 404
  response.end(JSON.stringify({ message: 'not found' }))
}

function privateKey(type: 'pkcs1' | 'pkcs8') {
  return generateKeyPairSync('rsa', { modulusLength: 2048 }).privateKey.export({ type, format: 'pem' }).toString()
}
