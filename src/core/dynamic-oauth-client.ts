import { z } from 'zod'
import { sha256Base64Url } from './digest.js'
import { failedDependency } from './problem.js'

const registrationSchema = z.object({ client_id: z.string().min(1) })
const tokenSchema = z.object({
  access_token: z.string().min(1),
  refresh_token: z.string().min(1).optional(),
  expires_in: z.number().int().positive(),
  scope: z.union([z.string(), z.array(z.string())]).optional(),
})

export type DynamicOAuthRegistrationStore = {
  clientId(providerId: string): Promise<string | null>
  saveClientId(providerId: string, clientId: string): Promise<string>
}

export type DynamicOAuthToken = Readonly<{
  accessToken: string
  refreshToken?: string
  expiresAt: number
  scopes: readonly string[]
}>

export type DynamicOAuthEndpoints = Readonly<{
  authorization: string
  registration: string
  token: string
  userInfo: string
  revocation?: string
}>

export class D1DynamicOAuthRegistrationStore implements DynamicOAuthRegistrationStore {
  constructor(private readonly db: D1Database) {}

  async clientId(providerId: string) {
    const row = await this.db
      .prepare('SELECT client_id AS clientId FROM managed_oauth_client WHERE provider_id = ?')
      .bind(providerId)
      .first<{ clientId: string }>()
    return row?.clientId ?? null
  }

  async saveClientId(providerId: string, clientId: string) {
    await this.db
      .prepare('INSERT OR IGNORE INTO managed_oauth_client (provider_id, client_id, created_at) VALUES (?, ?, ?)')
      .bind(providerId, clientId, Date.now())
      .run()
    const stored = await this.clientId(providerId)
    if (!stored) throw new Error(`Could not persist the ${providerId} OAuth client registration.`)
    return stored
  }
}

export function createDynamicOAuthClient(input: {
  providerId: string
  clientName: string
  endpoints: DynamicOAuthEndpoints
  redirectUri: string
  scopes: readonly string[]
  authorizationScopeSeparator?: ' ' | ','
  registrationStore: DynamicOAuthRegistrationStore
  fetcher?: typeof fetch
  now?: () => number
}) {
  const fetcher = input.fetcher ?? fetch
  const now = input.now ?? Date.now
  const revocationEndpoint = input.endpoints.revocation

  return {
    async authorizationUrl(state: string) {
      const verifier = randomVerifier()
      const clientId = await registeredClientId()
      const url = new URL(input.endpoints.authorization)
      url.searchParams.set('client_id', clientId)
      url.searchParams.set('redirect_uri', input.redirectUri)
      url.searchParams.set('response_type', 'code')
      url.searchParams.set('scope', input.scopes.join(input.authorizationScopeSeparator ?? ' '))
      url.searchParams.set('state', state)
      url.searchParams.set('code_challenge', await sha256Base64Url(verifier))
      url.searchParams.set('code_challenge_method', 'S256')
      return { url: url.toString(), verifier }
    },
    exchangeCode(code: string, verifier: string) {
      return tokenRequest({
        grant_type: 'authorization_code',
        code,
        redirect_uri: input.redirectUri,
        code_verifier: verifier,
      })
    },
    refresh(refreshToken: string) {
      return tokenRequest({ grant_type: 'refresh_token', refresh_token: refreshToken })
    },
    ...(revocationEndpoint
      ? {
          async revoke(token: string) {
            const response = await fetcher(new URL(revocationEndpoint), {
              method: 'POST',
              headers: { 'content-type': 'application/x-www-form-urlencoded' },
              body: new URLSearchParams({
                token,
                token_type_hint: 'refresh_token',
                client_id: await registeredClientId(),
              }),
              signal: AbortSignal.timeout(10_000),
            })
            if (!response.ok) throw providerFailure(response, 'OAuth token revocation')
          },
        }
      : {}),
    async userInfo(accessToken: string) {
      const response = await fetcher(new URL(input.endpoints.userInfo), {
        headers: { authorization: `Bearer ${accessToken}` },
        signal: AbortSignal.timeout(10_000),
      })
      if (!response.ok) throw providerFailure(response, 'OAuth userinfo request')
      return response.json() as Promise<unknown>
    },
  }

  async function registeredClientId() {
    const existing = await input.registrationStore.clientId(input.providerId)
    if (existing) return existing
    const response = await fetcher(new URL(input.endpoints.registration), {
      method: 'POST',
      headers: { accept: 'application/json', 'content-type': 'application/json' },
      body: JSON.stringify({
        client_name: input.clientName,
        redirect_uris: [input.redirectUri],
        grant_types: ['authorization_code', 'refresh_token'],
        response_types: ['code'],
        token_endpoint_auth_method: 'none',
        scope: input.scopes.join(' '),
      }),
      signal: AbortSignal.timeout(10_000),
    })
    if (!response.ok) throw providerFailure(response, 'dynamic client registration')
    return input.registrationStore.saveClientId(
      input.providerId,
      registrationSchema.parse(await response.json()).client_id,
    )
  }

  async function tokenRequest(parameters: Record<string, string>): Promise<DynamicOAuthToken> {
    const response = await fetcher(new URL(input.endpoints.token), {
      method: 'POST',
      headers: { accept: 'application/json', 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ ...parameters, client_id: await registeredClientId() }),
      signal: AbortSignal.timeout(10_000),
    })
    if (!response.ok) throw providerFailure(response, 'OAuth token request')
    const token = tokenSchema.parse(await response.json())
    return {
      accessToken: token.access_token,
      ...(token.refresh_token ? { refreshToken: token.refresh_token } : {}),
      expiresAt: now() + token.expires_in * 1000,
      scopes: normalizeScopes(token.scope ?? input.scopes),
    }
  }
}

function randomVerifier() {
  const bytes = crypto.getRandomValues(new Uint8Array(48))
  return btoa(String.fromCharCode(...bytes))
    .replaceAll('+', '-')
    .replaceAll('/', '_')
    .replace(/=+$/, '')
}

function normalizeScopes(value: string | readonly string[]) {
  const scopes = typeof value === 'string' ? value.split(/[\s,]+/) : value
  return [...new Set(scopes.filter(Boolean))].sort()
}

function providerFailure(response: Response, operation: string) {
  return failedDependency(`The upstream provider rejected ${operation} with ${response.status}.`)
}
