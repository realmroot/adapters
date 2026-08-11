import { z } from 'zod'
import { HttpProblem } from './problem.js'

const discoverySchema = z.object({ token_endpoint: z.url() })
const tokenSchema = z.object({
  access_token: z.string().min(1),
  issued_token_type: z.string().optional(),
  token_type: z.literal('Bearer'),
  expires_in: z.number().int().positive(),
  scope: z.string(),
})

export type RealmrootTokenExchangeClient = {
  exchange(input: { subjectToken: string; audience: string; scopes: readonly string[] }): Promise<{
    accessToken: string
    expiresIn: number
    scopes: ReadonlySet<string>
  }>
}

export function createRealmrootTokenExchangeClient(input: {
  issuer: string
  clientId: string
  clientSecret: string
  fetch?: typeof fetch
  timeoutMs?: number
}): RealmrootTokenExchangeClient {
  const request = input.fetch ?? fetch
  const timeoutMs = input.timeoutMs ?? 10_000
  return {
    async exchange(exchange) {
      const metadataResponse = await request(`${input.issuer}/.well-known/openid-configuration`, {
        signal: AbortSignal.timeout(timeoutMs),
      }).catch(() => {
        throw unavailable('Realmroot issuer discovery is temporarily unavailable.')
      })
      if (!metadataResponse.ok) throw unavailable('Realmroot issuer discovery is temporarily unavailable.')
      const metadata = discoverySchema.safeParse(await metadataResponse.json().catch(() => null))
      if (!metadata.success) throw unavailable('Realmroot issuer discovery returned an invalid document.')

      const form = new URLSearchParams({
        grant_type: 'urn:ietf:params:oauth:grant-type:token-exchange',
        subject_token: exchange.subjectToken,
        subject_token_type: 'urn:ietf:params:oauth:token-type:access_token',
        requested_token_type: 'urn:ietf:params:oauth:token-type:access_token',
        audience: exchange.audience,
        scope: [...exchange.scopes].sort().join(' '),
      })
      const response = await request(metadata.data.token_endpoint, {
        method: 'POST',
        headers: {
          authorization: `Basic ${btoa(`${input.clientId}:${input.clientSecret}`)}`,
          'content-type': 'application/x-www-form-urlencoded',
        },
        body: form,
        signal: AbortSignal.timeout(timeoutMs),
      }).catch(() => {
        throw unavailable('Realmroot token exchange is temporarily unavailable.')
      })
      if (!response.ok) {
        const retryAfter = response.headers.get('retry-after')
        throw new HttpProblem(
          response.status >= 500 ? 503 : response.status,
          'urn:realmroot:adapter:token-exchange-failed',
          response.status >= 500 ? 'Service Unavailable' : 'Forbidden',
          'Realmroot denied the delegated provider token exchange.',
          retryAfter ? { 'Retry-After': retryAfter } : {},
        )
      }
      const parsed = tokenSchema.safeParse(await response.json().catch(() => null))
      if (!parsed.success) throw unavailable('Realmroot token exchange returned an invalid response.')
      return {
        accessToken: parsed.data.access_token,
        expiresIn: parsed.data.expires_in,
        scopes: new Set(parsed.data.scope.split(/\s+/).filter(Boolean)),
      }
    },
  }
}

function unavailable(detail: string) {
  return new HttpProblem(503, 'urn:realmroot:adapter:temporarily-unavailable', 'Service Unavailable', detail)
}
