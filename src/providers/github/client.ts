import { importPKCS8, SignJWT } from 'jose'
import { z } from 'zod'
import { failedDependency } from '../../core/problem.js'
import type { GitHubProvider, GitHubRepository } from './types.js'

const githubApiVersion = '2026-03-10'
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
    const privateKey = await importPKCS8(input.privateKey, 'RS256')
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
