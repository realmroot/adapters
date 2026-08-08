import { importPKCS8, SignJWT } from 'jose'
import { z } from 'zod'
import { failedDependency } from '../../core/problem.js'
import type { GitHubConnectionProvider, GitHubProvider, GitHubRepository } from './types.js'

const githubApiVersion = '2026-03-10'
const userAgent = 'realmroot-adapters/0.1'
const repositoriesSchema = z.object({
  total_count: z.number().int().nonnegative(),
  repositories: z.array(
    z.object({
      id: z.number().int().positive(),
      name: z.string(),
      full_name: z.string(),
      private: z.boolean(),
      html_url: z.url(),
      owner: z.object({ login: z.string() }),
    }),
  ),
})
const installationTokenSchema = z.object({ token: z.string().min(1), expires_at: z.iso.datetime() })
const issueSchema = z.object({
  id: z.number().int().positive(),
  number: z.number().int().positive(),
  title: z.string(),
  body: z.string().nullable(),
  state: z.string(),
  html_url: z.url(),
})
const oauthTokenSchema = z.object({ access_token: z.string().min(1) })
const userSchema = z.object({ id: z.number().int().positive(), login: z.string().min(1), name: z.string().nullable() })
const userInstallationsSchema = z.object({
  installations: z.array(
    z.object({
      id: z.number().int().positive(),
      account: z.object({ login: z.string().min(1) }),
      target_type: z.string().min(1),
    }),
  ),
})
const appSchema = z.object({ slug: z.string().min(1) })

export function createGitHubProvider(input: {
  appId: string
  privateKey: string
  apiOrigin: string
  fetcher?: typeof fetch
  now?: () => number
}): GitHubProvider {
  const fetcher = input.fetcher ?? fetch
  const now = input.now ?? Date.now

  return {
    async listRepositories(installationId, page, perPage) {
      const token = await installationToken(installationId, {})
      const url = new URL('/installation/repositories', input.apiOrigin)
      url.searchParams.set('page', String(page))
      url.searchParams.set('per_page', String(perPage))
      const response = await github(url, { token })
      const parsed = repositoriesSchema.parse(await response.json())
      return { items: parsed.repositories.map(toRepository), total: parsed.total_count }
    },

    async createIssue(issue) {
      const repository = await findRepository(issue.installationId, issue.owner, issue.repository)
      const token = await installationToken(issue.installationId, {
        repository_ids: [repository.id],
        permissions: { issues: 'write' },
      })
      const path = `/repos/${encodeURIComponent(issue.owner)}/${encodeURIComponent(issue.repository)}/issues`
      const response = await github(new URL(path, input.apiOrigin), {
        method: 'POST',
        token,
        body: { title: issue.title, body: issue.body },
      })
      const parsed = issueSchema.parse(await response.json())
      return {
        id: parsed.id,
        number: parsed.number,
        title: parsed.title,
        body: parsed.body,
        state: parsed.state,
        htmlUrl: parsed.html_url,
      }
    },
  }

  async function findRepository(installationId: number, owner: string, name: string) {
    let page = 1
    while (true) {
      const result = await providerListRepositories(installationId, page, 100)
      const match = result.items.find(
        (repository) =>
          repository.owner.toLowerCase() === owner.toLowerCase() &&
          repository.name.toLowerCase() === name.toLowerCase(),
      )
      if (match) return match
      if (page * 100 >= result.total) throw failedDependency('The repository is not selected for this installation.')
      page += 1
    }
  }

  async function providerListRepositories(installationId: number, page: number, perPage: number) {
    const token = await installationToken(installationId, {})
    const url = new URL('/installation/repositories', input.apiOrigin)
    url.searchParams.set('page', String(page))
    url.searchParams.set('per_page', String(perPage))
    const response = await github(url, { token })
    const parsed = repositoriesSchema.parse(await response.json())
    return { items: parsed.repositories.map(toRepository), total: parsed.total_count }
  }

  async function installationToken(installationId: number, downscope: Record<string, unknown>) {
    const jwt = await appJwt()
    const response = await github(new URL(`/app/installations/${installationId}/access_tokens`, input.apiOrigin), {
      method: 'POST',
      token: jwt,
      body: downscope,
    })
    return installationTokenSchema.parse(await response.json()).token
  }

  async function appJwt() {
    const current = Math.floor(now() / 1000)
    const privateKey = await importPKCS8(toPkcs8(input.privateKey), 'RS256')
    return new SignJWT({})
      .setProtectedHeader({ alg: 'RS256', typ: 'JWT' })
      .setIssuer(input.appId)
      .setIssuedAt(current - 60)
      .setExpirationTime(current + 9 * 60)
      .sign(privateKey)
  }

  async function github(url: URL, request: { token: string; method?: string; body?: Record<string, unknown> }) {
    const response = await fetcher(url, {
      method: request.method ?? 'GET',
      headers: {
        accept: 'application/vnd.github+json',
        authorization: `Bearer ${request.token}`,
        'user-agent': userAgent,
        'x-github-api-version': githubApiVersion,
        ...(request.body ? { 'content-type': 'application/json' } : {}),
      },
      ...(request.body ? { body: JSON.stringify(request.body) } : {}),
      signal: AbortSignal.timeout(10_000),
    })
    if (!response.ok) {
      const requestId = response.headers.get('x-github-request-id')
      throw failedDependency(
        `GitHub rejected the request with ${response.status}${requestId ? ` (${requestId})` : ''}.`,
      )
    }
    return response
  }
}

export function createGitHubConnectionProvider(input: {
  appId: string
  privateKey: string
  clientId: string
  clientSecret: string
  apiOrigin: string
  fetcher?: typeof fetch
  now?: () => number
}): GitHubConnectionProvider {
  const fetcher = input.fetcher ?? fetch
  const now = input.now ?? Date.now

  return {
    authorizationUrl(state) {
      const url = new URL('https://github.com/login/oauth/authorize')
      url.searchParams.set('client_id', input.clientId)
      url.searchParams.set('state', state)
      return url.toString()
    },
    async exchangeUserCode(code) {
      const response = await fetcher('https://github.com/login/oauth/access_token', {
        method: 'POST',
        headers: { accept: 'application/json', 'content-type': 'application/json', 'user-agent': userAgent },
        body: JSON.stringify({ client_id: input.clientId, client_secret: input.clientSecret, code }),
        signal: AbortSignal.timeout(10_000),
      })
      if (!response.ok) throw failedDependency(`GitHub rejected OAuth authorization with ${response.status}.`)
      return oauthTokenSchema.parse(await response.json()).access_token
    },
    async getUser(token) {
      const response = await githubUserRequest('/user', token)
      return userSchema.parse(await response.json())
    },
    async listUserInstallations(token) {
      const response = await githubUserRequest('/user/installations?per_page=100', token)
      const parsed = userInstallationsSchema.parse(await response.json())
      return parsed.installations.map((installation) => ({
        id: installation.id,
        accountLogin: installation.account.login,
        targetType: installation.target_type,
      }))
    },
    async newInstallationUrl(state) {
      const jwt = await appJwt()
      const response = await githubUserRequest('/app', jwt)
      const app = appSchema.parse(await response.json())
      const url = new URL(`https://github.com/apps/${encodeURIComponent(app.slug)}/installations/new`)
      url.searchParams.set('state', state)
      return url.toString()
    },
  }

  async function appJwt() {
    const current = Math.floor(now() / 1000)
    const privateKey = await importPKCS8(toPkcs8(input.privateKey), 'RS256')
    return new SignJWT({})
      .setProtectedHeader({ alg: 'RS256', typ: 'JWT' })
      .setIssuer(input.appId)
      .setIssuedAt(current - 60)
      .setExpirationTime(current + 9 * 60)
      .sign(privateKey)
  }

  async function githubUserRequest(path: string, token: string) {
    const response = await fetcher(new URL(path, input.apiOrigin), {
      headers: {
        accept: 'application/vnd.github+json',
        authorization: `Bearer ${token}`,
        'user-agent': userAgent,
        'x-github-api-version': githubApiVersion,
      },
      signal: AbortSignal.timeout(10_000),
    })
    if (!response.ok) {
      const requestId = response.headers.get('x-github-request-id')
      const responseText = await response.text()
      const message = responseText ? `: ${responseText.slice(0, 500)}` : ''
      throw failedDependency(
        `GitHub rejected ${path} with ${response.status}${requestId ? ` (${requestId})` : ''}${message}.`,
      )
    }
    return response
  }
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
  const privateKey = der(0x04, pkcs1)
  const encoded = der(0x30, concat(version, rsaAlgorithm, privateKey))
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

function toRepository(input: z.infer<typeof repositoriesSchema>['repositories'][number]): GitHubRepository {
  return {
    id: input.id,
    name: input.name,
    fullName: input.full_name,
    private: input.private,
    htmlUrl: input.html_url,
    owner: input.owner.login,
  }
}
