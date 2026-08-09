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

export function createRealmrootConnectionEventSink(input: {
  issuer: string
  resource: string
  secret: string
  fetch: typeof fetch
  now?: () => number
  timeoutMs?: number
}): ConnectionEventSink {
  const secret = new TextEncoder().encode(input.secret)
  const now = input.now ?? Date.now
  const timeoutMs = input.timeoutMs ?? 10_000
  const request = input.fetch

  return {
    async send(event) {
      const pathname = `/api/provider-connection-events/${encodeURIComponent(event.id)}`
      const url = new URL(pathname, `${input.issuer}/`)
      const { id: _, type, brokerReference, occurredAt, revision, ...snapshot } = event
      const body = JSON.stringify({
        type,
        resource: input.resource,
        brokerReference,
        occurredAt,
        revision,
        ...snapshot,
      })
      const timestamp = String(Math.floor(now() / 1000))
      const signature = await hmacHex(secret, `${timestamp}\nPUT\n${pathname}\n${body}`)
      const response = await request(url, {
        method: 'PUT',
        headers: {
          Authorization: `Bearer ${input.secret}`,
          'Content-Type': 'application/json',
          'Realmroot-Signature': `sha256=${signature}`,
          'Realmroot-Timestamp': timestamp,
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

async function hmacHex(secret: Uint8Array, value: string) {
  const key = await crypto.subtle.importKey('raw', secret, { name: 'HMAC', hash: 'SHA-256' }, false, ['sign'])
  const digest = new Uint8Array(await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(value)))
  return [...digest].map((byte) => byte.toString(16).padStart(2, '0')).join('')
}
