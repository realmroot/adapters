import { importPKCS8, SignJWT } from 'jose'
import { z } from 'zod'
import { failedDependency } from '../../core/problem.js'
import { githubOpenApiSource } from './openapi-paths.js'
import type { GitHubConnectionProvider, GitHubPermissions, GitHubProvider } from './types.js'

const githubApiVersion = '2026-03-10'
const userAgent = 'realmroot-adapters/0.1'
const permissionsSchema = z.record(z.string(), z.enum(['read', 'write', 'admin']))
const installationTokenSchema = z.object({ token: z.string().min(1), expires_at: z.iso.datetime() })
const oauthTokenSchema = z.object({ access_token: z.string().min(1) })
const userSchema = z.object({ id: z.number().int().positive(), login: z.string().min(1), name: z.string().nullable() })
const userInstallationsSchema = z.object({
  installations: z.array(
    z.object({
      id: z.number().int().positive(),
      html_url: z.url().refine((value) => new URL(value).origin === 'https://github.com'),
      account: z.object({ login: z.string().min(1) }),
      target_type: z.string().min(1),
      permissions: permissionsSchema,
      repository_selection: z.enum(['all', 'selected']),
      updated_at: z.iso.datetime({ offset: true }),
    }),
  ),
})
const installationRepositoriesSchema = z.object({
  total_count: z.number().int().nonnegative(),
  repositories: z.array(z.object({ id: z.number().int().positive(), full_name: z.string().min(1) })),
})
const appSchema = z.object({ slug: z.string().min(1), permissions: permissionsSchema })

type GitHubClientInput = {
  appId: string
  privateKey: string
  apiOrigin: string
  fetcher?: typeof fetch
  cache?: Cache
  waitUntil?: (promise: Promise<unknown>) => void
  now?: () => number
}

export function createGitHubProvider(input: GitHubClientInput): GitHubProvider {
  const fetcher = input.fetcher ?? fetch
  const appJwt = createAppJwt(input)
  let permissionRequest: Promise<GitHubPermissions> | undefined

  return {
    appPermissions() {
      permissionRequest ??= readAppPermissions().catch((error: unknown) => {
        permissionRequest = undefined
        throw error
      })
      return permissionRequest
    },

    async openApiDocument() {
      const response = await fetcher(githubOpenApiSource, {
        headers: { accept: 'application/vnd.oai.openapi+json, application/json' },
        signal: AbortSignal.timeout(10_000),
      })
      if (!response.ok) throw failedDependency(`GitHub OpenAPI download failed with ${response.status}.`)
      return response
    },

    async installationToken(request) {
      const response = await githubRequest(
        new Request(new URL(`/app/installations/${request.installationId}/access_tokens`, input.apiOrigin), {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({
            ...(request.permissions ? { permissions: request.permissions } : {}),
            ...(request.repositories ? { repositories: request.repositories } : {}),
          }),
        }),
        await appJwt(),
      )
      return installationTokenSchema.parse(await response.json()).token
    },

    request(request, installationToken, mode = 'api') {
      return githubRequest(request, installationToken, false, mode)
    },
  }

  async function readAppPermissions() {
    const cacheKey = new Request(
      `https://cache.realmroot.invalid/github/apps/${encodeURIComponent(input.appId)}/permissions`,
    )
    const cached = await input.cache?.match(cacheKey)
    if (cached) return permissionsSchema.parse(await cached.json())
    const response = await githubRequest(new Request(new URL('/app', input.apiOrigin)), await appJwt())
    const permissions = appSchema.parse(await response.json()).permissions
    if (input.cache) {
      const write = input.cache.put(
        cacheKey,
        Response.json(permissions, { headers: { 'cache-control': 'public, max-age=10' } }),
      )
      input.waitUntil ? input.waitUntil(write) : await write
    }
    return permissions
  }

  async function githubRequest(request: Request, token: string, requireSuccess = true, mode: 'api' | 'git' = 'api') {
    const headers = forwardedHeaders(request.headers)
    headers.set('authorization', mode === 'git' ? `Basic ${btoa(`x-access-token:${token}`)}` : `Bearer ${token}`)
    headers.set('user-agent', userAgent)
    if (mode === 'api') {
      if (!headers.has('accept')) headers.set('accept', 'application/vnd.github+json')
      if (!headers.has('x-github-api-version')) headers.set('x-github-api-version', githubApiVersion)
    }
    const response = await fetcher(
      new Request(request, {
        headers,
        redirect: 'manual',
        signal: AbortSignal.timeout(mode === 'git' ? 10 * 60_000 : 30_000),
      }),
    )
    if (requireSuccess && !response.ok) throw await providerFailure(response, request.url)
    return response
  }
}

export function createGitHubConnectionProvider(
  input: GitHubClientInput & {
    clientId: string
    clientSecret: string
    redirectUri: string
  },
): GitHubConnectionProvider {
  const fetcher = input.fetcher ?? fetch
  const appJwt = createAppJwt(input)

  return {
    authorizationUrl(state) {
      const url = new URL('https://github.com/login/oauth/authorize')
      url.searchParams.set('client_id', input.clientId)
      url.searchParams.set('redirect_uri', input.redirectUri)
      url.searchParams.set('state', state)
      return url.toString()
    },
    async exchangeUserCode(code) {
      const response = await fetcher('https://github.com/login/oauth/access_token', {
        method: 'POST',
        headers: { accept: 'application/json', 'content-type': 'application/json', 'user-agent': userAgent },
        body: JSON.stringify({
          client_id: input.clientId,
          client_secret: input.clientSecret,
          code,
          redirect_uri: input.redirectUri,
        }),
        signal: AbortSignal.timeout(10_000),
      })
      if (!response.ok) throw failedDependency(`GitHub rejected OAuth authorization with ${response.status}.`)
      return oauthTokenSchema.parse(await response.json()).access_token
    },
    async getUser(token) {
      const response = await userRequest('/user', token)
      return userSchema.parse(await response.json())
    },
    async listUserInstallations(token) {
      const response = await userRequest('/user/installations?per_page=100', token)
      const parsed = userInstallationsSchema.parse(await response.json())
      return Promise.all(
        parsed.installations.map(async (installation) => ({
          id: installation.id,
          htmlUrl: installation.html_url,
          accountLogin: installation.account.login,
          targetType: installation.target_type,
          permissions: installation.permissions,
          repositorySelection: installation.repository_selection,
          repositories:
            installation.repository_selection === 'selected'
              ? await listInstallationRepositories(token, installation.id)
              : [],
          updatedAt: installation.updated_at,
        })),
      )
    },
    async newInstallationUrl(state) {
      const response = await userRequest('/app', await appJwt())
      const app = appSchema.parse(await response.json())
      const url = new URL(`https://github.com/apps/${encodeURIComponent(app.slug)}/installations/new`)
      url.searchParams.set('state', state)
      return url.toString()
    },
    permissionUpdateUrl(installation) {
      return `${installation.htmlUrl}/permissions/update`
    },
  }

  async function listInstallationRepositories(token: string, installationId: number) {
    const repositories: Array<{ id: number; fullName: string }> = []
    let page = 1
    let totalCount: number
    do {
      const suffix = page === 1 ? '' : `&page=${page}`
      const response = await userRequest(
        `/user/installations/${installationId}/repositories?per_page=100${suffix}`,
        token,
      )
      const parsed = installationRepositoriesSchema.parse(await response.json())
      totalCount = parsed.total_count
      repositories.push(
        ...parsed.repositories.map((repository) => ({ id: repository.id, fullName: repository.full_name })),
      )
      page += 1
    } while (repositories.length < totalCount)
    return repositories
  }

  async function userRequest(path: string, token: string) {
    const response = await fetcher(new URL(path, input.apiOrigin), {
      headers: {
        accept: 'application/vnd.github+json',
        authorization: `Bearer ${token}`,
        'user-agent': userAgent,
        'x-github-api-version': githubApiVersion,
      },
      signal: AbortSignal.timeout(10_000),
    })
    if (!response.ok) throw providerFailure(response, path)
    return response
  }
}

function createAppJwt(input: Pick<GitHubClientInput, 'appId' | 'privateKey' | 'now'>) {
  const now = input.now ?? Date.now
  let importedKey: ReturnType<typeof importPKCS8> | undefined
  return async () => {
    const current = Math.floor(now() / 1000)
    importedKey ??= importPKCS8(toPkcs8(input.privateKey), 'RS256')
    return new SignJWT({})
      .setProtectedHeader({ alg: 'RS256', typ: 'JWT' })
      .setIssuer(input.appId)
      .setIssuedAt(current - 60)
      .setExpirationTime(current + 9 * 60)
      .sign(await importedKey)
  }
}

function forwardedHeaders(input: Headers) {
  const headers = new Headers(input)
  for (const name of ['authorization', 'dpop', 'host', 'content-length', 'connection', 'cookie']) headers.delete(name)
  return headers
}

async function providerFailure(response: Response, target: string) {
  const requestId = response.headers.get('x-github-request-id')
  const body = z.object({ message: z.string().min(1).max(500) }).safeParse(
    await response
      .clone()
      .json()
      .catch(() => null),
  )
  const message = body.success ? `: ${body.data.message}` : ''
  return failedDependency(
    `GitHub rejected ${new URL(target, 'https://api.github.com').pathname} with ${response.status}${requestId ? ` (${requestId})` : ''}${message}.`,
  )
}

function toPkcs8(pem: string) {
  if (pem.includes('-----BEGIN PRIVATE KEY-----')) return pem
  const match = pem.match(/-----BEGIN RSA PRIVATE KEY-----([\s\S]+)-----END RSA PRIVATE KEY-----/)
  if (!match) throw new TypeError('GitHub private key must be PEM-encoded RSA PKCS#1 or PKCS#8.')
  const encodedKey = match[1]
  if (!encodedKey) throw new TypeError('GitHub private key does not contain RSA key data.')
  const pkcs1 = Uint8Array.from(atob(encodedKey.replace(/\s/g, '')), (character) => character.charCodeAt(0))
  const version = Uint8Array.of(0x02, 0x01, 0x00)
  const rsaAlgorithm = Uint8Array.of(
    0x30,
    0x0d,
    0x06,
    0x09,
    0x2a,
    0x86,
    0x48,
    0x86,
    0xf7,
    0x0d,
    0x01,
    0x01,
    0x01,
    0x05,
    0x00,
  )
  const encoded = der(0x30, concat(version, rsaAlgorithm, der(0x04, pkcs1)))
  const base64 =
    btoa(String.fromCharCode(...encoded))
      .match(/.{1,64}/g)
      ?.join('\n') ?? ''
  return `-----BEGIN PRIVATE KEY-----\n${base64}\n-----END PRIVATE KEY-----`
}

function der(tag: number, value: Uint8Array) {
  return concat(Uint8Array.of(tag), derLength(value.length), value)
}

function derLength(length: number) {
  if (length < 128) return Uint8Array.of(length)
  const bytes: number[] = []
  for (let remaining = length; remaining > 0; remaining >>= 8) bytes.unshift(remaining & 0xff)
  return Uint8Array.of(0x80 | bytes.length, ...bytes)
}

function concat(...values: Uint8Array[]) {
  const result = new Uint8Array(values.reduce((length, value) => length + value.length, 0))
  let offset = 0
  for (const value of values) {
    result.set(value, offset)
    offset += value.length
  }
  return result
}
