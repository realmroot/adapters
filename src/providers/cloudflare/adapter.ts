import type { Hono } from 'hono'
import type { AdapterEnv, AdapterModule } from '../../core/adapter.js'
import type { RealmrootTokenExchangeClient } from '../../core/oauth-client.js'
import { forbidden, HttpProblem } from '../../core/problem.js'
import type { RealmrootAuthenticator } from '../../core/realmroot-auth.js'
import type { CloudflareAdapterConfig } from './config.js'
import { cloudflareManifest } from './manifest.js'
import { type CloudflareOperation, cloudflareOperations } from './operation-permissions.js'

type Operation = CloudflareOperation

export type CloudflareAdapterDependencies = {
  authenticator: RealmrootAuthenticator
  exchange: RealmrootTokenExchangeClient
  audit: (record: Record<string, unknown>) => Promise<void>
  fetch?: typeof fetch
}

const operationIndex = buildOperationIndex(cloudflareOperations)
const removedRequestHeaders = new Set([
  'authorization',
  'dpop',
  'cookie',
  'host',
  'connection',
  'proxy-connection',
  'keep-alive',
  'transfer-encoding',
  'upgrade',
  'te',
  'trailer',
  'forwarded',
  'cf-connecting-ip',
  'cf-ipcountry',
  'cf-ray',
  'x-forwarded-for',
  'x-forwarded-host',
  'x-forwarded-proto',
  'x-real-ip',
])
const removedResponseHeaders = new Set([
  'set-cookie',
  'connection',
  'proxy-connection',
  'keep-alive',
  'transfer-encoding',
  'upgrade',
  'te',
  'trailer',
])

export function createCloudflareAdapter(
  config: CloudflareAdapterConfig,
  dependencies: CloudflareAdapterDependencies,
): AdapterModule {
  const resource = `${config.origin}/cloudflare`
  const request = dependencies.fetch ?? fetch
  return {
    id: 'cloudflare',
    register(app) {
      registerRoutes(app)
    },
  }

  function registerRoutes(app: Hono<AdapterEnv>) {
    app.get('/providers/cloudflare/manifest', (c) => c.json(cloudflareManifest))
    app.get('/.well-known/oauth-protected-resource/cloudflare', (c) =>
      c.json({
        resource,
        authorization_servers: [config.realmrootIssuer],
        scopes_supported: Object.keys(cloudflareManifest.scopes).sort(),
        bearer_methods_supported: ['header'],
      }),
    )
    app.get('/cloudflare', (c) =>
      c.json(
        {
          resource,
          serviceDescription: `${resource}/openapi.json`,
          identityLevel: 'oauth-delegated-user',
          toolIntegrations: [
            { id: 'wrangler', executables: ['wrangler', 'npx', 'pnpm'], protocol: 'cloudflare-api-base' },
          ],
        },
        200,
        {
          Link: `<${resource}/openapi.json>; rel="service-desc"; type="application/vnd.oai.openapi+json"`,
        },
      ),
    )
    app.get('/cloudflare/user/tokens/verify', async (c) => {
      const principal = await dependencies.authenticator.authenticate(c.req.raw, resource)
      const requiredScope = [...principal.scopes].sort().find((scope) => scope in cloudflareManifest.scopes)
      if (!requiredScope) throw forbidden('The Agent token has no approved Cloudflare scope for Wrangler verification.')
      if (!principal.subjectToken) throw forbidden('The Realmroot Agent subject token is unavailable.')
      const provider = await dependencies.exchange.exchange({
        subjectToken: principal.subjectToken,
        audience: resource,
        scopes: [requiredScope],
      })
      if (!provider.scopes.has(requiredScope))
        throw forbidden('The Cloudflare OAuth grant does not authorize Wrangler verification.')
      await dependencies.audit({
        event: 'provider.operation',
        requestId: c.get('requestId'),
        provider: 'cloudflare',
        operationId: 'wrangler-token-verification',
        method: 'GET',
        pathTemplate: '/user/tokens/verify',
        scope: requiredScope,
        originatingPrincipal: { issuer: principal.actor.issuer, subject: principal.actor.subject },
        providerActor: { type: 'oauth_delegated_user' },
        identityLevel: 'brokered',
        result: { status: 200 },
        occurredAt: new Date().toISOString(),
      })
      return c.json({
        success: true,
        errors: [],
        messages: [],
        result: { id: 'realmroot-agent-authority', status: 'active' },
      })
    })
    app.get('/cloudflare/user', async (c) => {
      const principal = await dependencies.authenticator.authenticate(c.req.raw, resource)
      const requiredScope = [...principal.scopes].sort().find((scope) => scope in cloudflareManifest.scopes)
      if (!requiredScope || !principal.subjectToken)
        throw forbidden('The Agent token has no approved Cloudflare authority for Wrangler identity.')
      const provider = await dependencies.exchange.exchange({
        subjectToken: principal.subjectToken,
        audience: resource,
        scopes: [requiredScope],
      })
      if (!provider.scopes.has(requiredScope))
        throw forbidden('The Cloudflare OAuth grant does not authorize Wrangler identity.')
      return c.json({
        success: true,
        errors: [],
        messages: [],
        result: {
          id: principal.actor.subject,
          email: `${principal.actor.subject}@agents.realmroot.dev`,
        },
      })
    })
    app.get('/cloudflare/accounts', async (c) => {
      const principal = await dependencies.authenticator.authenticate(c.req.raw, resource)
      const requiredScope = 'account-settings.read'
      if (!principal.scopes.has(requiredScope) || !principal.subjectToken)
        throw forbidden(`The Agent token does not authorize ${requiredScope}.`)
      const provider = await dependencies.exchange.exchange({
        subjectToken: principal.subjectToken,
        audience: resource,
        scopes: [requiredScope],
      })
      if (!provider.scopes.has(requiredScope))
        throw forbidden('The Cloudflare OAuth grant does not authorize account discovery.')
      const upstream = new URL(config.cloudflareApiOrigin)
      upstream.pathname = `${upstream.pathname.replace(/\/$/, '')}/accounts`
      upstream.search = new URL(c.req.url).search
      const response = await request(upstream, {
        headers: { authorization: `Bearer ${provider.accessToken}` },
        redirect: 'manual',
        signal: AbortSignal.timeout(15_000),
      })
      return new Response(response.body, {
        status: response.status,
        statusText: response.statusText,
        headers: sanitizedHeaders(response.headers, removedResponseHeaders),
      })
    })
    app.get('/cloudflare/memberships', async (c) => {
      const principal = await dependencies.authenticator.authenticate(c.req.raw, resource)
      const hasApprovedScope = [...principal.scopes].some((scope) => scope in cloudflareManifest.scopes)
      if (!hasApprovedScope)
        throw forbidden('The Agent token has no approved Cloudflare authority for Wrangler membership lookup.')
      return c.json({ success: true, errors: [], messages: [], result: [], result_info: { count: 0 } })
    })
    app.all('/cloudflare/*', async (c) => {
      if (c.req.path === '/cloudflare/openapi.json') return c.notFound()
      const suffix = c.req.path.slice('/cloudflare'.length)
      const operation = matchOperation(c.req.method, suffix)
      if (!operation) throw new HttpProblem(404, 'about:blank', 'Not Found', 'Cloudflare operation is not published.')
      const principal = await dependencies.authenticator.authenticate(c.req.raw, resource)
      const requiredScope = operation.scopes.find((scope) => principal.scopes.has(scope))
      if (!requiredScope) throw forbidden('The Agent token does not authorize this Cloudflare operation.')
      if (!principal.subjectToken) throw forbidden('The Realmroot Agent subject token is unavailable.')
      const provider = await dependencies.exchange.exchange({
        subjectToken: principal.subjectToken,
        audience: resource,
        scopes: [requiredScope],
      })
      if (!provider.scopes.has(requiredScope))
        throw forbidden('The Cloudflare OAuth grant does not authorize this operation.')

      const upstream = new URL(config.cloudflareApiOrigin)
      upstream.pathname = `${new URL(config.cloudflareApiOrigin).pathname.replace(/\/$/, '')}${suffix}`
      upstream.search = new URL(c.req.url).search
      const headers = sanitizedHeaders(c.req.raw.headers, removedRequestHeaders)
      headers.set('authorization', `Bearer ${provider.accessToken}`)
      const body = bodyFor(c.req.raw)
      const startedAt = Date.now()
      const response = await request(upstream, {
        method: c.req.method,
        headers,
        ...(body ? { body } : {}),
        ...(body instanceof ReadableStream ? { duplex: 'half' as const } : {}),
        redirect: 'manual',
        signal: AbortSignal.timeout(15_000),
      } as RequestInit & { duplex?: 'half' })
      await dependencies.audit({
        event: 'provider.operation',
        requestId: c.get('requestId'),
        provider: 'cloudflare',
        operationId: operation.operationId,
        method: operation.method,
        pathTemplate: operation.path,
        scope: requiredScope,
        originatingPrincipal: { issuer: principal.actor.issuer, subject: principal.actor.subject },
        providerActor: { type: 'oauth_delegated_user' },
        identityLevel: 'brokered',
        result: {
          status: response.status,
          ...(response.headers.get('cf-ray') ? { cfRay: response.headers.get('cf-ray') } : {}),
        },
        durationMs: Date.now() - startedAt,
        occurredAt: new Date().toISOString(),
      })
      return new Response(response.body, {
        status: response.status,
        statusText: response.statusText,
        headers: sanitizedHeaders(response.headers, removedResponseHeaders),
      })
    })
  }
}

function buildOperationIndex(operations: readonly Operation[]) {
  const result = new Map<string, Map<string, Operation>>()
  for (const operation of operations) {
    const method = result.get(operation.method) ?? new Map<string, Operation>()
    const signature = operation.path
      .split('/')
      .map((segment) => (segment.startsWith('{') && segment.endsWith('}') ? '{}' : segment))
      .join('/')
    if (method.has(signature)) throw new Error(`Ambiguous Cloudflare route template: ${operation.method} ${signature}`)
    method.set(signature, operation)
    result.set(operation.method, method)
  }
  return result
}

function matchOperation(method: string, path: string) {
  const index = operationIndex.get(method.toUpperCase())
  if (!index) return undefined
  const segments = path.split('/')
  for (const [signature, operation] of index) {
    const candidate = signature.split('/')
    if (candidate.length !== segments.length) continue
    if (candidate.every((segment, position) => segment === '{}' || segment === segments[position])) return operation
  }
  return undefined
}

function sanitizedHeaders(source: Headers, removed: ReadonlySet<string>) {
  const result = new Headers()
  for (const [name, value] of source) {
    if (!removed.has(name.toLowerCase())) result.append(name, value)
  }
  return result
}

function bodyFor(request: Request) {
  return request.method === 'GET' || request.method === 'HEAD' ? undefined : request.body
}
