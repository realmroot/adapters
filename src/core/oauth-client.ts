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
  retryBaseDelayMs?: number
}): RealmrootTokenExchangeClient {
  const request = input.fetch ?? fetch
  const timeoutMs = input.timeoutMs ?? 15_000
  const retryBaseDelayMs = input.retryBaseDelayMs ?? 100
  return {
    async exchange(exchange) {
      const deadline = Date.now() + timeoutMs
      const metadataResponse = await transientRequest(
        request,
        `${input.issuer}/.well-known/openid-configuration`,
        {},
        deadline,
        retryBaseDelayMs,
        'Realmroot issuer discovery is temporarily unavailable.',
      )
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
      const response = await transientRequest(
        request,
        metadata.data.token_endpoint,
        {
          method: 'POST',
          headers: {
            authorization: `Basic ${btoa(`${input.clientId}:${input.clientSecret}`)}`,
            'content-type': 'application/x-www-form-urlencoded',
          },
          body: form,
        },
        deadline,
        retryBaseDelayMs,
        'Realmroot token exchange is temporarily unavailable.',
      )
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

async function transientRequest(
  request: typeof fetch,
  target: string,
  init: RequestInit,
  deadline: number,
  retryBaseDelayMs: number,
  failureDetail: string,
) {
  const maxAttempts = 3
  for (let attempt = 0; ; attempt += 1) {
    const remainingMs = deadline - Date.now()
    if (remainingMs <= 0) throw unavailable(failureDetail)
    try {
      const response = await request(target, { ...init, signal: AbortSignal.timeout(remainingMs) })
      if (!isTransient(response.status) || attempt === maxAttempts - 1) return response
      await response.body?.cancel()
    } catch {
      if (attempt === maxAttempts - 1) throw unavailable(failureDetail)
    }
    const backoffMs = Math.floor(retryBaseDelayMs * (2 ** attempt + Math.random()))
    const delayMs = Math.min(backoffMs, Math.max(0, deadline - Date.now()))
    if (delayMs > 0) await delay(delayMs)
  }
}

function isTransient(status: number) {
  return status === 408 || status === 429 || status >= 500
}

function delay(milliseconds: number) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds))
}

function unavailable(detail: string) {
  return new HttpProblem(503, 'urn:realmroot:adapter:temporarily-unavailable', 'Service Unavailable', detail)
}
