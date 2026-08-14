import type { Hono } from 'hono'
import {
  calculateJwkThumbprint,
  createLocalJWKSet,
  createRemoteJWKSet,
  decodeJwt,
  decodeProtectedHeader,
  importJWK,
  type JWK,
  jwtVerify,
  SignJWT,
} from 'jose'
import type { AdapterEnv } from './adapter.js'
import {
  type D1ExternalOAuthStore,
  type ExternalOAuthGrant,
  type ExternalOAuthIntent,
  sha256,
  sha256Base64Url,
} from './external-oauth-store.js'
import { HttpProblem } from './problem.js'
import type { DpopReplayStore, RealmrootAuthenticator } from './realmroot-auth.js'

const jwtBearerGrant = 'urn:ietf:params:oauth:grant-type:jwt-bearer'
const tokenExchangeGrant = 'urn:ietf:params:oauth:grant-type:token-exchange'
const accessTokenType = 'urn:ietf:params:oauth:token-type:access_token'

export type ExternalProviderAuthorization = {
  id: string
  resource: string
  scopes: readonly string[]
  authorizationDetailsTypes?: readonly string[]
  authorizationDetailsCatalog?: {
    scope: string
    list(input: { subject: string; limit: number; offset: number }): Promise<{
      items: Array<{
        authorizationDetail: Record<string, unknown>
        display: { label: string; description?: string; metadata?: Record<string, string> }
      }>
      pagination: { limit: number; offset: number; total: number; hasMore: boolean; nextOffset: number | null }
    }>
  }
  authorizationDetailsSubset?(input: {
    requested: Array<Record<string, unknown>>
    granted: Array<Record<string, unknown>>
  }): boolean
  validateGrant?(input: {
    subject: string
    scopes: string[]
    authorizationDetails: Array<Record<string, unknown>>
  }): Promise<boolean>
  revoke?(subject: string): Promise<void>
  begin(input: {
    providerState: string
    scopes: string[]
    authorizationDetails: Array<Record<string, unknown>>
  }):
    | Promise<{ url: string; stage: string; data?: Record<string, unknown> }>
    | { url: string; stage: string; data?: Record<string, unknown> }
  complete(input: {
    callbackUrl: string
    intent: ExternalOAuthIntent
    nextProviderState(): string
  }): Promise<
    | { type: 'continue'; url: string; stage: string; data: Record<string, unknown>; providerState: string }
    | { type: 'complete'; grant: Omit<ExternalOAuthGrant, 'providerId' | 'clientId'> }
    | { type: 'error'; error: 'access_denied' | 'server_error'; description: string }
  >
}

export type ExternalAuthorizationServer = {
  readonly id: string
  register(app: Hono<AdapterEnv>): void
  authenticator: RealmrootAuthenticator
}

export async function createExternalAuthorizationServer(input: {
  origin: string
  provider: ExternalProviderAuthorization
  providerCallbackPath?: string
  store: D1ExternalOAuthStore
  signingPrivateJwk: JWK
  replayStore: DpopReplayStore
}): Promise<ExternalAuthorizationServer> {
  const issuer = `${input.origin}/oauth/${input.provider.id}`
  const providerCallbackPath = input.providerCallbackPath ?? `/oauth/${input.provider.id}/provider/callback`
  const privateKey = await importJWK(input.signingPrivateJwk, 'ES256')
  const signingKid = input.signingPrivateJwk.kid ?? 'adapter-oauth-signing-key'
  const { d: _privateScalar, ...exportedPublicJwk } = input.signingPrivateJwk
  const publicJwk: JWK = {
    ...exportedPublicJwk,
    kid: signingKid,
    use: 'sig',
    alg: 'ES256',
  }
  const keySet = createLocalJWKSet({ keys: [publicJwk] })

  return {
    id: `${input.provider.id}-authorization-server`,
    register(app) {
      app.get(`/.well-known/oauth-authorization-server/oauth/${input.provider.id}`, (c) => c.json(metadata()))
      app.get(`/.well-known/openid-configuration/oauth/${input.provider.id}`, (c) => c.json(metadata()))
      app.get(`/oauth/${input.provider.id}/jwks`, (c) => c.json({ keys: [publicJwk] }))
      app.post(`/oauth/${input.provider.id}/register`, async (c) => {
        const body = await c.req.json<Record<string, unknown>>()
        const redirectUris = stringArray(body.redirect_uris)
        const jwksUri = requiredUrl(body.jwks_uri, 'jwks_uri')
        if (redirectUris.length === 0 || redirectUris.some((uri) => !validRedirectUri(uri))) {
          throw oauthError('invalid_client_metadata', 'Valid redirect_uris are required.')
        }
        const grants = stringArray(body.grant_types)
        for (const required of ['authorization_code', 'refresh_token', jwtBearerGrant, tokenExchangeGrant]) {
          if (!grants.includes(required)) {
            throw oauthError('invalid_client_metadata', `grant_types must include ${required}.`)
          }
        }
        const clientId = opaque('client')
        const clientSecret = opaque('secret')
        await input.store.registerClient({
          clientId,
          providerId: input.provider.id,
          clientSecretHash: await sha256(clientSecret),
          redirectUris,
          jwksUri,
        })
        return c.json(
          {
            client_id: clientId,
            client_secret: clientSecret,
            client_id_issued_at: Math.floor(Date.now() / 1000),
            redirect_uris: redirectUris,
            token_endpoint_auth_method: 'client_secret_basic',
          },
          201,
        )
      })
      app.get(`/oauth/${input.provider.id}/authorize`, async (c) => {
        const query = c.req.query()
        const clientId = required(query.client_id, 'client_id')
        const redirectUri = required(query.redirect_uri, 'redirect_uri')
        const client = await requireClient(input.store, input.provider.id, clientId)
        if (!client.redirectUris.includes(redirectUri))
          throw oauthError('invalid_request', 'redirect_uri does not match.')
        if (query.response_type !== 'code' || query.code_challenge_method !== 'S256') {
          throw oauthError('invalid_request', 'Authorization code with S256 PKCE is required.')
        }
        const scopes = normalizeScopes(required(query.scope, 'scope'))
        assertScopes(scopes, input.provider.scopes)
        const authorizationDetails = parseAuthorizationDetails(query.authorization_details)
        assertAuthorizationDetailsTypes(authorizationDetails, input.provider.authorizationDetailsTypes ?? [])
        const providerState = opaque('state')
        const started = await input.provider.begin({ providerState, scopes, authorizationDetails })
        await input.store.createIntent(
          {
            id: crypto.randomUUID(),
            providerId: input.provider.id,
            clientId,
            redirectUri,
            realmrootState: required(query.state, 'state'),
            scopes,
            authorizationDetails,
            codeChallenge: required(query.code_challenge, 'code_challenge'),
            providerStage: started.stage,
            providerData: started.data ?? {},
            expiresAt: Date.now() + 10 * 60_000,
          },
          await sha256(providerState),
        )
        return c.redirect(started.url)
      })
      app.get(providerCallbackPath, async (c) => {
        const state = required(c.req.query('state'), 'state')
        const intent = await input.store.intentByProviderState(await sha256(state))
        const providerError = c.req.query('error')
        if (providerError) {
          await input.store.cancelIntent(intent)
          return c.redirect(
            authorizationErrorRedirect(
              intent,
              providerError === 'access_denied' ? 'access_denied' : 'server_error',
              providerError === 'access_denied'
                ? 'Provider authorization was denied.'
                : 'Provider authorization failed.',
            ),
          )
        }
        const result = await input.provider.complete({
          callbackUrl: c.req.url,
          intent,
          nextProviderState: () => opaque('state'),
        })
        if (result.type === 'continue') {
          await input.store.advanceIntent({
            id: intent.id,
            expectedStage: intent.providerStage,
            providerStateHash: await sha256(result.providerState),
            providerStage: result.stage,
            providerData: result.data,
          })
          return c.redirect(result.url)
        }
        if (result.type === 'error') {
          await input.store.cancelIntent(intent)
          return c.redirect(authorizationErrorRedirect(intent, result.error, result.description))
        }
        const code = opaque('code')
        await input.store.completeIntent(
          intent,
          { ...result.grant, providerId: input.provider.id, clientId: intent.clientId },
          code,
        )
        const callback = new URL(intent.redirectUri)
        callback.searchParams.set('code', code)
        callback.searchParams.set('state', intent.realmrootState)
        return c.redirect(callback.toString())
      })
      app.post(`/oauth/${input.provider.id}/token`, async (c) => {
        const client = await authenticateClient(input.store, input.provider.id, c.req.raw)
        const form = await c.req.formData()
        const grantType = requiredForm(form, 'grant_type')
        if (grantType === 'authorization_code') {
          const grant = await input.store.consumeCode({
            code: requiredForm(form, 'code'),
            clientId: client.clientId,
            redirectUri: requiredForm(form, 'redirect_uri'),
            verifier: requiredForm(form, 'code_verifier'),
          })
          const refreshToken = opaque('refresh')
          await input.store.createRefresh(grant, refreshToken)
          return c.json({
            access_token: await subjectToken(grant),
            refresh_token: refreshToken,
            token_type: 'Bearer',
            expires_in: 300,
            scope: grant.scopes.join(' '),
            authorization_details: grant.authorizationDetails,
          })
        }
        if (grantType === 'refresh_token') {
          const grant = await input.store.refreshGrant(requiredForm(form, 'refresh_token'), client.clientId)
          return c.json({
            access_token: await subjectToken(grant),
            token_type: 'Bearer',
            expires_in: 300,
            scope: grant.scopes.join(' '),
            authorization_details: grant.authorizationDetails,
          })
        }
        if (grantType === jwtBearerGrant) {
          const assertion = requiredForm(form, 'assertion')
          const verified = await jwtVerify(assertion, createRemoteJWKSet(new URL(client.jwksUri)), {
            audience: `${issuer}/token`,
          }).catch(() => {
            throw oauthError('invalid_grant', 'Agent assertion is invalid.')
          })
          if (typeof verified.payload.iss !== 'string' || typeof verified.payload.sub !== 'string') {
            throw oauthError('invalid_grant', 'Agent assertion requires iss and sub.')
          }
          return c.json({
            access_token: await actorToken(client.clientId, verified.payload.iss, verified.payload.sub),
            token_type: 'Bearer',
            expires_in: 300,
          })
        }
        if (grantType === tokenExchangeGrant) {
          requireTokenType(form, 'subject_token_type')
          requireTokenType(form, 'actor_token_type')
          requireTokenType(form, 'requested_token_type')
          const requestedResource = requiredForm(form, 'resource')
          if (requestedResource !== input.provider.resource)
            throw oauthError('invalid_target', 'resource is unsupported.')
          const subject = await verifyAccessToken(
            requiredForm(form, 'subject_token'),
            input.provider.resource,
            'subject',
          )
          const actor = await verifyAccessToken(requiredForm(form, 'actor_token'), issuer, 'actor')
          if (subject.payload.client_id !== client.clientId || actor.payload.client_id !== client.clientId) {
            throw oauthError('invalid_grant', 'Tokens were not issued to this client.')
          }
          const scopes = normalizeScopes(requiredForm(form, 'scope'))
          const subjectScopes = normalizeScopes(String(subject.payload.scope ?? ''))
          if (scopes.some((scope) => !subjectScopes.includes(scope))) {
            throw oauthError('invalid_scope', 'Requested scope exceeds the connected account.')
          }
          const authorizationDetails = parseAuthorizationDetails(form.get('authorization_details'))
          const subjectDetails = authorizationDetailsValue(subject.payload.authorization_details)
          if (
            !(input.provider.authorizationDetailsSubset ?? authorizationDetailsSubset)({
              requested: authorizationDetails,
              granted: subjectDetails,
            })
          ) {
            throw oauthError('invalid_authorization_details', 'Requested authorization details exceed the connection.')
          }
          let providerGrantActive = true
          if (input.provider.validateGrant) {
            try {
              providerGrantActive = await input.provider.validateGrant({
                subject: String(subject.payload.sub),
                scopes,
                authorizationDetails,
              })
            } catch (error) {
              if (!(error instanceof HttpProblem) || error.status !== 403) throw error
              providerGrantActive = false
            }
          }
          if (!providerGrantActive) {
            throw oauthError('invalid_grant', 'The provider authorization is no longer active.')
          }
          const proof = await verifyDpop(c.req.raw, `${issuer}/token`, input.replayStore)
          const jti = crypto.randomUUID()
          const expiresAt = Date.now() + 5 * 60_000
          const accessToken = await new SignJWT({
            scope: scopes.join(' '),
            client_id: client.clientId,
            authorization_details: authorizationDetails,
            act: {
              iss: actor.payload.agent_iss,
              sub: actor.payload.sub,
              sub_profile: 'ai_agent',
            },
            cnf: { jkt: proof.jkt },
          })
            .setProtectedHeader({ alg: 'ES256', kid: signingKid, typ: 'at+jwt' })
            .setIssuer(issuer)
            .setSubject(String(subject.payload.sub))
            .setAudience(input.provider.resource)
            .setJti(jti)
            .setIssuedAt()
            .setExpirationTime(Math.floor(expiresAt / 1000))
            .sign(privateKey)
          await input.store.recordAccess({
            jti,
            providerId: input.provider.id,
            clientId: client.clientId,
            subject: String(subject.payload.sub),
            expiresAt,
          })
          return c.json({
            access_token: accessToken,
            issued_token_type: accessTokenType,
            token_type: 'DPoP',
            expires_in: 300,
            scope: scopes.join(' '),
            authorization_details: authorizationDetails,
          })
        }
        throw oauthError('unsupported_grant_type', 'grant_type is unsupported.')
      })
      app.post(`/oauth/${input.provider.id}/revoke`, async (c) => {
        const client = await authenticateClient(input.store, input.provider.id, c.req.raw)
        const form = await c.req.formData()
        const token = requiredForm(form, 'token')
        try {
          const claims = decodeJwt(token)
          if (typeof claims.jti === 'string') await input.store.revokeAccess(claims.jti, client.clientId)
        } catch {
          const revoked = await input.store.revokeRefresh(token, client.clientId)
          if (revoked?.lastForSubject) await input.provider.revoke?.(revoked.grant.subject)
        }
        return c.body(null, 200)
      })
      app.get(`/oauth/${input.provider.id}/userinfo`, async (c) => {
        const token = bearer(c.req.raw)
        const verified = await verifyAccessToken(token, input.provider.resource, 'subject')
        return c.json({
          sub: verified.payload.sub,
          name: verified.payload.name,
          preferred_username: verified.payload.name,
        })
      })
      const authorizationDetailsCatalog = input.provider.authorizationDetailsCatalog
      if (authorizationDetailsCatalog) {
        app.get(`/oauth/${input.provider.id}/authorization-details`, async (c) => {
          const token = bearer(c.req.raw)
          const verified = await verifyAccessToken(token, input.provider.resource, 'subject')
          const scopes = normalizeScopes(String(verified.payload.scope ?? ''))
          if (!scopes.includes(authorizationDetailsCatalog.scope)) {
            throw oauthError('insufficient_scope', 'The access token does not authorize catalog discovery.', 403)
          }
          return c.json(
            await authorizationDetailsCatalog.list({
              subject: String(verified.payload.sub),
              limit: paginationInteger(c.req.query('limit'), 'limit', 50, 1),
              offset: paginationInteger(c.req.query('offset'), 'offset', 0, 0),
            }),
          )
        })
      }
    },
    authenticator: {
      async authenticate(request, audience) {
        if (audience !== input.provider.resource) throw oauthError('invalid_target', 'Token audience is unsupported.')
        const token = dpopToken(request)
        const verified = await verifyAccessToken(token, audience, 'target')
        if (typeof verified.payload.jti !== 'string' || !(await input.store.activeAccess(verified.payload.jti))) {
          throw oauthError('invalid_token', 'Access token is inactive.', 401)
        }
        const proof = await verifyDpop(request, dpopTargetUri(request.url), input.replayStore, token)
        const confirmation = verified.payload.cnf as { jkt?: unknown } | undefined
        if (confirmation?.jkt !== proof.jkt) throw oauthError('invalid_token', 'DPoP key does not match.', 401)
        const actor = verified.payload.act as { iss?: unknown; sub?: unknown; sub_profile?: unknown } | undefined
        if (
          typeof verified.payload.sub !== 'string' ||
          typeof actor?.iss !== 'string' ||
          typeof actor.sub !== 'string' ||
          actor.sub_profile !== 'ai_agent'
        ) {
          throw oauthError('invalid_token', 'Token does not identify an Agent.', 401)
        }
        return {
          subject: verified.payload.sub,
          issuer,
          actor: { issuer: actor.iss, subject: actor.sub, profile: 'ai_agent' },
          scopes: new Set(normalizeScopes(String(verified.payload.scope ?? ''))),
          authorizationDetails: authorizationDetailsValue(verified.payload.authorization_details),
        }
      },
    },
  }

  function metadata() {
    const catalog = input.provider.authorizationDetailsCatalog
    return {
      issuer,
      authorization_endpoint: `${issuer}/authorize`,
      token_endpoint: `${issuer}/token`,
      registration_endpoint: `${issuer}/register`,
      revocation_endpoint: `${issuer}/revoke`,
      jwks_uri: `${issuer}/jwks`,
      userinfo_endpoint: `${issuer}/userinfo`,
      scopes_supported: input.provider.scopes,
      authorization_details_types_supported: input.provider.authorizationDetailsTypes ?? [],
      ...(catalog
        ? {
            authorization_details_catalog_endpoint: `${issuer}/authorization-details`,
            authorization_details_catalog_scope: catalog.scope,
            authorization_details_catalog_version: 1,
          }
        : {}),
      response_types_supported: ['code'],
      response_modes_supported: ['query'],
      grant_types_supported: ['authorization_code', 'refresh_token', jwtBearerGrant, tokenExchangeGrant],
      token_endpoint_auth_methods_supported: ['client_secret_basic'],
      code_challenge_methods_supported: ['S256'],
      dpop_signing_alg_values_supported: ['ES256'],
    }
  }

  async function subjectToken(grant: ExternalOAuthGrant) {
    return new SignJWT({
      scope: grant.scopes.join(' '),
      client_id: grant.clientId,
      name: grant.displayName,
      authorization_details: grant.authorizationDetails,
      token_use: 'subject',
    })
      .setProtectedHeader({ alg: 'ES256', kid: signingKid, typ: 'at+jwt' })
      .setIssuer(issuer)
      .setSubject(grant.subject)
      .setAudience(input.provider.resource)
      .setJti(crypto.randomUUID())
      .setIssuedAt()
      .setExpirationTime('5m')
      .sign(privateKey)
  }

  async function actorToken(clientId: string, agentIssuer: string, agentSubject: string) {
    return new SignJWT({ client_id: clientId, agent_iss: agentIssuer, token_use: 'actor' })
      .setProtectedHeader({ alg: 'ES256', kid: signingKid, typ: 'at+jwt' })
      .setIssuer(issuer)
      .setSubject(agentSubject)
      .setAudience(issuer)
      .setJti(crypto.randomUUID())
      .setIssuedAt()
      .setExpirationTime('5m')
      .sign(privateKey)
  }

  async function verifyAccessToken(token: string, audience: string, use: 'subject' | 'actor' | 'target') {
    const verified = await jwtVerify(token, keySet, { issuer, audience, typ: 'at+jwt' }).catch(() => {
      throw oauthError('invalid_grant', 'Access token is invalid.')
    })
    if (use !== 'target' && verified.payload.token_use !== use) {
      throw oauthError('invalid_grant', `Expected a ${use} token.`)
    }
    return verified
  }
}

function authorizationErrorRedirect(
  intent: ExternalOAuthIntent,
  error: 'access_denied' | 'server_error',
  description: string,
) {
  const callback = new URL(intent.redirectUri)
  callback.searchParams.set('error', error)
  callback.searchParams.set('error_description', description)
  callback.searchParams.set('state', intent.realmrootState)
  return callback.toString()
}

async function authenticateClient(store: D1ExternalOAuthStore, providerId: string, request: Request) {
  const header = request.headers.get('authorization')
  if (!header?.startsWith('Basic ')) throw oauthError('invalid_client', 'Client authentication is required.', 401)
  const decoded = atob(header.slice(6))
  const separator = decoded.indexOf(':')
  const clientId = decodeURIComponent(decoded.slice(0, separator))
  const clientSecret = decodeURIComponent(decoded.slice(separator + 1))
  const client = await requireClient(store, providerId, clientId)
  if ((await sha256(clientSecret)) !== client.clientSecretHash) {
    throw oauthError('invalid_client', 'Client authentication failed.', 401)
  }
  return client
}

async function requireClient(store: D1ExternalOAuthStore, providerId: string, clientId: string) {
  const client = await store.client(providerId, clientId)
  if (!client) throw oauthError('invalid_client', 'OAuth client was not found.', 401)
  return client
}

async function verifyDpop(request: Request, htu: string, replayStore: DpopReplayStore, accessToken?: string) {
  const compact = request.headers.get('dpop')
  if (!compact) throw oauthError('invalid_dpop_proof', 'DPoP proof is required.', 401)
  const header = decodeProtectedHeader(compact)
  if (header.typ?.toLowerCase() !== 'dpop+jwt' || header.alg !== 'ES256' || !header.jwk) {
    throw oauthError('invalid_dpop_proof', 'DPoP proof header is invalid.', 401)
  }
  const verified = await jwtVerify(compact, await importJWK(header.jwk, 'ES256'), { typ: 'dpop+jwt' }).catch(() => {
    throw oauthError('invalid_dpop_proof', 'DPoP proof signature is invalid.', 401)
  })
  if (
    verified.payload.htu !== htu ||
    verified.payload.htm !== request.method ||
    typeof verified.payload.iat !== 'number' ||
    typeof verified.payload.jti !== 'string' ||
    Math.abs(Date.now() / 1000 - verified.payload.iat) > 300
  ) {
    throw oauthError('invalid_dpop_proof', 'DPoP proof target or lifetime is invalid.', 401)
  }
  if (accessToken && verified.payload.ath !== (await sha256Base64Url(accessToken))) {
    throw oauthError('invalid_dpop_proof', 'DPoP access-token hash is invalid.', 401)
  }
  const jkt = await calculateJwkThumbprint(header.jwk)
  if (
    !(await replayStore.claim({
      keyThumbprint: jkt,
      jti: verified.payload.jti,
      expiresAt: (verified.payload.iat + 300) * 1000,
      now: Date.now(),
    }))
  ) {
    throw oauthError('invalid_dpop_proof', 'DPoP proof was already used.', 401)
  }
  return { jkt }
}

function parseAuthorizationDetails(value: unknown): Array<Record<string, unknown>> {
  if (value === undefined || value === null || value === '') return []
  let parsed: unknown = value
  if (typeof value === 'string') {
    try {
      parsed = JSON.parse(value)
    } catch {
      throw oauthError('invalid_authorization_details', 'authorization_details must be valid JSON.')
    }
  }
  return authorizationDetailsValue(parsed)
}

function authorizationDetailsValue(value: unknown): Array<Record<string, unknown>> {
  if (!Array.isArray(value) || value.some((detail) => !detail || typeof detail !== 'object' || Array.isArray(detail))) {
    throw oauthError('invalid_authorization_details', 'authorization_details must be an object array.')
  }
  return value as Array<Record<string, unknown>>
}

function assertAuthorizationDetailsTypes(details: Array<Record<string, unknown>>, supported: readonly string[]) {
  if (details.some((detail) => typeof detail.type !== 'string' || !supported.includes(detail.type))) {
    throw oauthError('invalid_authorization_details', 'authorization_details contains an unsupported type.')
  }
}

function authorizationDetailsSubset(input: {
  requested: Array<Record<string, unknown>>
  granted: Array<Record<string, unknown>>
}) {
  const { requested, granted } = input
  if (requested.length === 0) return true
  const grantedCanonical = new Set(granted.map(canonicalJson))
  return requested.every((detail) => grantedCanonical.has(canonicalJson(detail)))
}

function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`
  if (value && typeof value === 'object') {
    return `{${Object.entries(value as Record<string, unknown>)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, item]) => `${JSON.stringify(key)}:${canonicalJson(item)}`)
      .join(',')}}`
  }
  return JSON.stringify(value)
}

function assertScopes(requested: string[], supported: readonly string[]) {
  if (requested.some((scope) => !supported.includes(scope))) throw oauthError('invalid_scope', 'scope is unsupported.')
}

function requireTokenType(form: FormData, name: string) {
  if (requiredForm(form, name) !== accessTokenType) throw oauthError('invalid_request', `${name} is unsupported.`)
}

function requiredForm(form: FormData, name: string) {
  return required(form.get(name), name)
}

function required(value: unknown, name: string) {
  if (typeof value !== 'string' || !value) throw oauthError('invalid_request', `${name} is required.`)
  return value
}

function requiredUrl(value: unknown, name: string) {
  const url = required(value, name)
  try {
    return new URL(url).toString()
  } catch {
    throw oauthError('invalid_client_metadata', `${name} must be a URL.`)
  }
}

function stringArray(value: unknown) {
  return Array.isArray(value) && value.every((item) => typeof item === 'string') ? value : []
}

function normalizeScopes(value: string) {
  return [...new Set(value.split(/\s+/).filter(Boolean))].sort()
}

function paginationInteger(value: string | undefined, name: string, fallback: number, minimum: number) {
  if (value === undefined) return fallback
  const parsed = Number(value)
  if (!Number.isSafeInteger(parsed) || parsed < minimum || (name === 'limit' && parsed > 100)) {
    throw oauthError('invalid_request', `${name} is invalid.`)
  }
  return parsed
}

function validRedirectUri(value: string) {
  try {
    const url = new URL(value)
    return url.protocol === 'https:' || (url.protocol === 'http:' && ['127.0.0.1', 'localhost'].includes(url.hostname))
  } catch {
    return false
  }
}

function bearer(request: Request) {
  const header = request.headers.get('authorization')
  if (!header?.startsWith('Bearer ')) throw oauthError('invalid_token', 'Bearer token is required.', 401)
  return header.slice(7)
}

function dpopToken(request: Request) {
  const header = request.headers.get('authorization')
  if (!header?.startsWith('DPoP ')) throw oauthError('invalid_token', 'DPoP token is required.', 401)
  return header.slice(5)
}

function dpopTargetUri(requestUrl: string) {
  const url = new URL(requestUrl)
  url.search = ''
  url.hash = ''
  return url.toString()
}

function opaque(prefix: string) {
  const bytes = crypto.getRandomValues(new Uint8Array(24))
  return `${prefix}_${btoa(String.fromCharCode(...bytes))
    .replaceAll('+', '-')
    .replaceAll('/', '_')
    .replace(/=+$/, '')}`
}

export class OAuthProtocolError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly status = 400,
  ) {
    super(message)
  }
}

function oauthError(code: string, message: string, status = 400) {
  return new OAuthProtocolError(code, message, status)
}
