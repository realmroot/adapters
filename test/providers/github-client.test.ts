import { generateKeyPairSync } from 'node:crypto'
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { createGitHubProvider } from '../../src/providers/github/client.js'

type SeenRequest = { method: string; url: string; authorization: string | undefined; body: unknown }
let closeServer: (() => Promise<void>) | undefined

afterEach(async () => closeServer?.())

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

  it('discovers installation repositories and downscopes issue credentials to one repository', async () => {
    const privateKey = generateKeyPairSync('rsa', { modulusLength: 2048 })
      .privateKey.export({ type: 'pkcs1', format: 'pem' })
      .toString()
    const provider = createGitHubProvider({ appId: '123', privateKey, apiOrigin, now: () => 1_800_000_000_000 })

    await expect(provider.listRepositories(42, 1, 30)).resolves.toMatchObject({
      items: [{ id: 99, fullName: 'realmroot/example' }],
    })
    await expect(
      provider.createIssue({
        installationId: 42,
        owner: 'realmroot',
        repository: 'example',
        title: 'Hello',
        body: 'Body',
      }),
    ).resolves.toMatchObject({ number: 7, htmlUrl: 'https://github.com/realmroot/example/issues/7' })

    const tokenRequests = seen.filter((request) => request.url === '/app/installations/42/access_tokens')
    expect(tokenRequests).toHaveLength(3)
    expect(tokenRequests[2]?.body).toEqual({ repository_ids: [99], permissions: { issues: 'write' } })
    expect(seen.at(-1)).toMatchObject({
      method: 'POST',
      url: '/repos/realmroot/example/issues',
      authorization: 'Bearer installation-token',
      body: { title: 'Hello', body: 'Body' },
    })
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
  if (request.url === '/app/installations/42/access_tokens') {
    response.statusCode = 201
    response.end(JSON.stringify({ token: 'installation-token', expires_at: '2030-01-01T00:00:00Z' }))
    return
  }
  if (request.url?.startsWith('/installation/repositories')) {
    response.end(JSON.stringify({ total_count: 1, repositories: [repository()] }))
    return
  }
  if (request.url === '/repos/realmroot/example/issues') {
    response.statusCode = 201
    response.end(
      JSON.stringify({
        id: 700,
        number: 7,
        title: 'Hello',
        body: 'Body',
        state: 'open',
        html_url: 'https://github.com/realmroot/example/issues/7',
      }),
    )
    return
  }
  response.statusCode = 404
  response.end(JSON.stringify({ message: 'not found' }))
}

function repository() {
  return {
    id: 99,
    name: 'example',
    full_name: 'realmroot/example',
    private: false,
    html_url: 'https://github.com/realmroot/example',
    owner: { login: 'realmroot' },
  }
}
