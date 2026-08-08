import {
  calculateJwkThumbprint,
  createLocalJWKSet,
  createRemoteJWKSet,
  decodeProtectedHeader,
  importJWK,
  type JSONWebKeySet,
  jwtVerify,
} from 'jose'
import { sha256Base64Url } from './digest.js'
import { unauthorized } from './problem.js'

export type AgentPrincipal = Readonly<{
  subject: string
  issuer: string
  actor: Readonly<{ issuer: string; subject: string; profile: 'ai_agent' }>
  scopes: ReadonlySet<string>
}>

export type RealmrootAuthenticator = {
  authenticate(request: Request, audience: string): Promise<AgentPrincipal>
}

export interface DpopReplayStore {
  claim(input: { keyThumbprint: string; jti: string; expiresAt: number; now: number }): Promise<boolean>
}

export function createRealmrootAuthenticator(input: {
  issuer: string
  jwksUrl?: string
  jwks?: JSONWebKeySet
  replayStore: DpopReplayStore
  now?: () => number
}): RealmrootAuthenticator {
  const keySet = input.jwks
    ? createLocalJWKSet(input.jwks)
    : createRemoteJWKSet(new URL(input.jwksUrl ?? `${input.issuer}/jwks`))
  const now = input.now ?? Date.now

  return {
    async authenticate(request, audience) {
      const token = dpopToken(request)
      const access = await jwtVerify(token, keySet, {
        algorithms: ['RS256'],
        issuer: input.issuer,
        audience,
        typ: 'at+jwt',
      }).catch(() => {
        throw unauthorized('The Realmroot access token is invalid.')
      })

      const proof = await verifyProof(request, token, input.replayStore, now)
      const confirmation = access.payload.cnf as { jkt?: unknown } | undefined
      if (confirmation?.jkt !== proof.jkt) throw unauthorized('The DPoP key does not match the access token.')

      const actor = access.payload.act as { iss?: unknown; sub?: unknown; sub_profile?: unknown } | undefined
      if (
        typeof access.payload.sub !== 'string' ||
        typeof actor?.iss !== 'string' ||
        typeof actor.sub !== 'string' ||
        actor.sub_profile !== 'ai_agent'
      ) {
        throw unauthorized('The access token does not identify a Realmroot Agent.')
      }

      return Object.freeze({
        subject: access.payload.sub,
        issuer: input.issuer,
        actor: Object.freeze({ issuer: actor.iss, subject: actor.sub, profile: 'ai_agent' as const }),
        scopes: new Set(
          typeof access.payload.scope === 'string' ? access.payload.scope.split(/\s+/).filter(Boolean) : [],
        ),
      })
    },
  }
}

async function verifyProof(request: Request, token: string, replayStore: DpopReplayStore, now: () => number) {
  const compact = request.headers.get('dpop')
  if (!compact) throw unauthorized('A DPoP proof is required.', 'invalid_dpop_proof')

  const header = parseDpopHeader(compact)
  const jwk = header.jwk
  if (header.typ?.toLowerCase() !== 'dpop+jwt' || header.alg !== 'ES256' || !jwk) {
    throw unauthorized('The DPoP proof header is invalid.', 'invalid_dpop_proof')
  }

  const verified = await jwtVerify(compact, await importJWK(jwk, 'ES256'), {
    algorithms: ['ES256'],
    typ: 'dpop+jwt',
  }).catch(() => {
    throw unauthorized('The DPoP proof signature is invalid.', 'invalid_dpop_proof')
  })

  const issuedAt = verified.payload.iat
  const jti = verified.payload.jti
  if (
    verified.payload.htu !== request.url ||
    verified.payload.htm !== request.method ||
    typeof issuedAt !== 'number' ||
    Math.abs(now() / 1000 - issuedAt) > 300 ||
    typeof jti !== 'string'
  ) {
    throw unauthorized('The DPoP proof target or lifetime is invalid.', 'invalid_dpop_proof')
  }
  if (verified.payload.ath !== (await sha256Base64Url(token))) {
    throw unauthorized('The DPoP access-token hash is invalid.', 'invalid_dpop_proof')
  }

  const jkt = await calculateJwkThumbprint(jwk)
  const claimed = await replayStore.claim({
    keyThumbprint: jkt,
    jti,
    expiresAt: (issuedAt + 300) * 1000,
    now: now(),
  })
  if (!claimed) throw unauthorized('The DPoP proof was already used.', 'invalid_dpop_proof')
  return { jkt }
}

function parseDpopHeader(compact: string) {
  try {
    return decodeProtectedHeader(compact)
  } catch {
    throw unauthorized('The DPoP proof header is invalid.', 'invalid_dpop_proof')
  }
}

function dpopToken(request: Request) {
  const value = request.headers.get('authorization')
  if (!value?.startsWith('DPoP ')) throw unauthorized('A DPoP access token is required.')
  return value.slice(5)
}
