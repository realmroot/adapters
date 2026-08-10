import { exportJWK, generateKeyPair, type JWK, SignJWT } from 'jose'
import { z } from 'zod'
import { failedDependency } from './problem.js'

type AuthorizationDetail = Readonly<Record<string, unknown>>

type AuthorityConstraint = Readonly<{
  authorizationDetails: readonly AuthorizationDetail[]
  scopes: readonly string[]
}>

type ConnectionEventCommon = Readonly<{
  id: string
  brokerReference: string
  occurredAt: string
  revision: number
}>

export type ConnectionEvent = ConnectionEventCommon &
  (
    | Readonly<{
        type: 'authorityChanged'
        scopes: readonly string[]
        affectedScopes: readonly string[]
        affectedAuthorizationDetails: readonly AuthorizationDetail[]
        authorityConstraints: readonly AuthorityConstraint[]
      }>
    | Readonly<{
        type: 'resourcesChanged' | 'restored'
        scopes: readonly string[]
        authorizationDetails: readonly AuthorizationDetail[]
        authorityConstraints: readonly AuthorityConstraint[]
      }>
    | Readonly<{ type: 'suspended' | 'revoked' }>
  )

export interface ConnectionEventSink {
  send(event: ConnectionEvent): Promise<void>
}

const tokenResponseSchema = z.object({
  access_token: z.string().min(1),
  token_type: z.literal('DPoP'),
  expires_in: z.number().positive(),
  scope: z.string(),
})

export function createRealmrootConnectionEventSink(input: {
  issuer: string
  resourceServerId: string
  clientId: string
  clientSecret: string
  fetch: typeof fetch
  timeoutMs?: number
}): ConnectionEventSink {
  const timeoutMs = input.timeoutMs ?? 10_000
  const request = input.fetch
  const issuer = input.issuer.replace(/\/+$/, '')
  const origin = new URL(issuer).origin
  const tokenEndpoint = `${issuer}/oauth2/token`
  const audience = `${origin}/api`

  return {
    async send(event) {
      const key = await generateKeyPair('ES256', { extractable: true })
      const publicJwk = await exportJWK(key.publicKey)
      const tokenProof = await createDpopProof(key.privateKey, publicJwk, { htm: 'POST', htu: tokenEndpoint })
      const tokenResponse = await request(tokenEndpoint, {
        method: 'POST',
        headers: {
          Authorization: `Basic ${btoa(`${encodeURIComponent(input.clientId)}:${encodeURIComponent(input.clientSecret)}`)}`,
          'Content-Type': 'application/x-www-form-urlencoded',
          DPoP: tokenProof,
        },
        body: new URLSearchParams({
          grant_type: 'client_credentials',
          resource: audience,
          scope: 'connection-events:write',
        }),
        signal: AbortSignal.timeout(timeoutMs),
      })
      if (!tokenResponse.ok) {
        throw failedDependency(`Realmroot rejected the Application credentials with status ${tokenResponse.status}.`)
      }
      const parsedToken = tokenResponseSchema.safeParse(await tokenResponse.json())
      if (!parsedToken.success) throw failedDependency('Realmroot returned an invalid client-credentials response.')

      const pathname = `/api/resource-servers/${encodeURIComponent(input.resourceServerId)}/connection-events/${encodeURIComponent(event.id)}`
      const url = new URL(pathname, `${origin}/`)
      const { id: _, ...representation } = event
      const body = JSON.stringify(representation)
      const proof = await createDpopProof(key.privateKey, publicJwk, {
        htm: 'PUT',
        htu: url.toString(),
        ath: await sha256Base64Url(parsedToken.data.access_token),
      })
      const response = await request(url, {
        method: 'PUT',
        headers: {
          Authorization: `DPoP ${parsedToken.data.access_token}`,
          'Content-Type': 'application/json',
          DPoP: proof,
        },
        body,
        signal: AbortSignal.timeout(timeoutMs),
      })
      if (response.status !== 204) {
        throw failedDependency(`Realmroot rejected the Connection Event with status ${response.status}.`)
      }
    },
  }
}

async function createDpopProof(
  privateKey: CryptoKey,
  publicJwk: JWK,
  claims: { htm: string; htu: string; ath?: string },
) {
  return new SignJWT({ ...claims, iat: Math.floor(Date.now() / 1000), jti: crypto.randomUUID() })
    .setProtectedHeader({ typ: 'dpop+jwt', alg: 'ES256', jwk: publicJwk })
    .sign(privateKey)
}

async function sha256Base64Url(value: string) {
  return base64Url(new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value))))
}

function base64Url(value: Uint8Array) {
  return btoa(String.fromCharCode(...value))
    .replaceAll('+', '-')
    .replaceAll('/', '_')
    .replace(/=+$/, '')
}
