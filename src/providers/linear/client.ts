import { z } from 'zod'
import { failedDependency } from '../../core/problem.js'
import { type LinearScope, parseLinearScopes } from './scopes.js'
import type { LinearProvider, LinearToken, LinearViewer } from './types.js'

const tokenSchema = z.object({
  access_token: z.string().min(1),
  refresh_token: z.string().min(1),
  expires_in: z.number().int().positive(),
  scope: z.union([z.string(), z.array(z.string())]),
})
const viewerSchema = z.object({
  data: z.object({
    viewer: z.object({ id: z.string().min(1), name: z.string().min(1), email: z.string().nullable() }),
    organization: z.object({
      id: z.string().min(1),
      name: z.string().min(1),
      urlKey: z.string().min(1),
      logoUrl: z.string().nullable(),
    }),
  }),
  errors: z.array(z.unknown()).optional(),
})

const viewerQuery = `query RealmrootConnectionIdentity {
  viewer { id name email }
  organization { id name urlKey logoUrl }
}`

export function createLinearProvider(input: {
  clientId: string
  clientSecret: string
  redirectUri: string
  apiOrigin: string
  authorizationOrigin: string
  fetcher?: typeof fetch
  now?: () => number
}): LinearProvider {
  const fetcher = input.fetcher ?? fetch
  const now = input.now ?? Date.now

  return {
    authorizationUrl({ actor, state, scopes }) {
      const url = new URL('/oauth/authorize', input.authorizationOrigin)
      url.searchParams.set('client_id', input.clientId)
      url.searchParams.set('redirect_uri', input.redirectUri)
      url.searchParams.set('response_type', 'code')
      url.searchParams.set('scope', scopes.join(','))
      url.searchParams.set('state', state)
      url.searchParams.set('prompt', 'consent')
      if (actor === 'app') url.searchParams.set('actor', 'app')
      return url.toString()
    },
    exchangeCode(code) {
      return tokenRequest({ grant_type: 'authorization_code', code, redirect_uri: input.redirectUri })
    },
    refresh(refreshToken) {
      return tokenRequest({ grant_type: 'refresh_token', refresh_token: refreshToken })
    },
    async revoke(token) {
      const response = await fetcher(new URL('/oauth/revoke', input.apiOrigin), {
        method: 'POST',
        headers: { 'content-type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({ token, token_type_hint: 'refresh_token' }),
        signal: AbortSignal.timeout(10_000),
      })
      if (!response.ok) throw failedDependency(`Linear rejected OAuth revocation with ${response.status}.`)
    },
    async viewer(accessToken) {
      const response = await linearRequest(
        new Request(new URL('/graphql', input.apiOrigin), {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ query: viewerQuery }),
        }),
        accessToken,
      )
      if (!response.ok) throw providerFailure(response, 'identity query')
      const parsed = viewerSchema.parse(await response.json())
      if (parsed.errors?.length) throw failedDependency('Linear rejected the connection identity query.')
      return {
        user: parsed.data.viewer,
        workspace: parsed.data.organization,
      } satisfies LinearViewer
    },
    request: linearRequest,
  }

  async function tokenRequest(parameters: Record<string, string>): Promise<LinearToken> {
    const response = await fetcher(new URL('/oauth/token', input.apiOrigin), {
      method: 'POST',
      headers: { accept: 'application/json', 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        ...parameters,
        client_id: input.clientId,
        client_secret: input.clientSecret,
      }),
      signal: AbortSignal.timeout(10_000),
    })
    if (!response.ok) throw failedDependency(`Linear rejected OAuth token exchange with ${response.status}.`)
    const token = tokenSchema.parse(await response.json())
    return {
      accessToken: token.access_token,
      refreshToken: token.refresh_token,
      expiresAt: now() + token.expires_in * 1000,
      scopes: parseLinearScopes(token.scope),
    }
  }

  async function linearRequest(request: Request, accessToken: string) {
    const headers = new Headers(request.headers)
    for (const name of ['authorization', 'dpop', 'host', 'content-length', 'connection', 'cookie']) headers.delete(name)
    headers.set('authorization', `Bearer ${accessToken}`)
    return fetcher(
      new Request(request, {
        headers,
        redirect: 'manual',
        signal: AbortSignal.timeout(15_000),
      }),
    )
  }
}

function providerFailure(response: Response, operation: string) {
  return failedDependency(`Linear rejected the ${operation} with ${response.status}.`)
}

export function requestedLinearScopes(value: string) {
  return parseLinearScopes(value.split(/\s+/).filter(Boolean)) as LinearScope[]
}
