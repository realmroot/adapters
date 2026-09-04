import type { Context } from 'hono'
import type { AdapterEnv, AdapterModule } from './adapter.js'
import { forbidden, HttpProblem, insufficientScope } from './problem.js'
import type { RealmrootAuthenticator } from './realmroot-auth.js'

export type ManagedOpenApiCredential = Readonly<{
  authorization: string
  scopes: readonly string[]
  actorType: string
}>

export type ManagedOpenApiOperation = Readonly<{
  operationId: string
  method: string
  path: string
  upstreamPath: string
  scopes: readonly string[]
}>

export type ManagedOpenApiDefinition = Readonly<{
  id: string
  resource: string
  issuer: string
  upstreamOrigin: string
  scopes: Readonly<Record<string, string>>
  operations: readonly ManagedOpenApiOperation[]
  openapi: Record<string, unknown>
  manifest: Record<string, unknown>
  representation?: Record<string, unknown>
}>

export type ManagedOpenApiDependencies = Readonly<{
  authenticator: RealmrootAuthenticator
  credential(subject: string): Promise<ManagedOpenApiCredential>
  audit(record: Record<string, unknown>): Promise<void>
  fetch?: typeof fetch
}>

const removedRequestHeaders = new Set([
  'authorization',
  'dpop',
  'cookie',
  'host',
  'content-length',
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

export function createManagedOpenApiAdapter(
  definition: ManagedOpenApiDefinition,
  dependencies: ManagedOpenApiDependencies,
): AdapterModule {
  assertDefinition(definition)
  const request = dependencies.fetch ?? fetch
  const basePath = new URL(definition.resource).pathname.replace(/\/$/, '')

  return {
    id: definition.id,
    register(app) {
      app.get(`/providers/${definition.id}/manifest`, (c) => c.json(definition.manifest))
      app.get(`/.well-known/oauth-protected-resource/${definition.id}`, (c) =>
        c.json({
          resource: definition.resource,
          authorization_servers: [definition.issuer],
          scopes_supported: Object.keys(definition.scopes).sort(),
          bearer_methods_supported: [],
          dpop_bound_access_tokens_required: true,
        }),
      )
      app.get(`${basePath}/openapi.json`, (c) =>
        c.json(definition.openapi, 200, { 'Content-Type': 'application/vnd.oai.openapi+json' }),
      )
      app.get(basePath, (c) =>
        c.json(
          {
            resource: definition.resource,
            serviceDescription: `${definition.resource}/openapi.json`,
            authorizationModel: 'external',
            ...definition.representation,
          },
          200,
          {
            Link: `<${definition.resource}/openapi.json>; rel="service-desc"; type="application/vnd.oai.openapi+json"`,
          },
        ),
      )
      for (const operation of definition.operations) {
        app.on(operation.method.toUpperCase(), `${basePath}${operation.path}`, (c) => execute(c, operation))
      }
      app.all(`${basePath}/*`, () => {
        throw new HttpProblem(404, 'about:blank', 'Not Found', `${definition.id} operation is not published.`)
      })
    },
  }

  async function execute(c: Context<AdapterEnv>, operation: ManagedOpenApiOperation) {
    const principal = await dependencies.authenticator.authenticate(c.req.raw, definition.resource)
    const requiredScope = operation.scopes.find((scope) => principal.scopes.has(scope))
    if (!requiredScope) {
      throw insufficientScope(
        `The Agent token does not authorize this ${definition.id} operation.`,
        operation.scopes.map((scope) => [scope]),
      )
    }
    const credential = await dependencies.credential(principal.subject)
    if (!credential.scopes.includes(requiredScope)) {
      throw forbidden(`The ${definition.id} OAuth grant does not authorize this operation.`)
    }

    const upstream = new URL(definition.upstreamOrigin)
    upstream.pathname = `${upstream.pathname.replace(/\/$/, '')}${operation.upstreamPath}`
    upstream.search = new URL(c.req.url).search
    const headers = sanitizedHeaders(c.req.raw.headers, removedRequestHeaders)
    headers.set('authorization', credential.authorization)
    const body = bodyFor(c.req.raw)
    const startedAt = Date.now()
    const response = await request(upstream, {
      method: operation.method,
      headers,
      ...(body ? { body } : {}),
      ...(body instanceof ReadableStream ? { duplex: 'half' as const } : {}),
      redirect: 'manual',
      signal: AbortSignal.timeout(15_000),
    } as RequestInit & { duplex?: 'half' })
    await dependencies.audit({
      event: 'provider.operation',
      requestId: c.get('requestId'),
      provider: definition.id,
      operationId: operation.operationId,
      method: operation.method,
      pathTemplate: operation.path,
      scope: requiredScope,
      originatingPrincipal: { issuer: principal.actor.issuer, subject: principal.actor.subject },
      providerActor: { type: credential.actorType },
      identityLevel: 'provider-delegated',
      result: { status: response.status },
      durationMs: Date.now() - startedAt,
      occurredAt: new Date().toISOString(),
    })
    return new Response(response.body, {
      status: response.status,
      statusText: response.statusText,
      headers: sanitizedHeaders(response.headers, removedResponseHeaders),
    })
  }
}

function assertDefinition(definition: ManagedOpenApiDefinition) {
  if (new URL(definition.resource).origin !== new URL(definition.issuer).origin) {
    throw new TypeError('Managed OpenAPI resource and issuer must share an origin.')
  }
  const signatures = new Set<string>()
  for (const operation of definition.operations) {
    if (!operation.path.startsWith('/') || !operation.upstreamPath.startsWith('/')) {
      throw new TypeError('Managed OpenAPI operation paths must be absolute paths.')
    }
    if (operation.scopes.length === 0 || operation.scopes.some((scope) => !(scope in definition.scopes))) {
      throw new TypeError(`Managed OpenAPI operation ${operation.operationId} has an undeclared scope.`)
    }
    const signature = `${operation.method.toUpperCase()} ${operation.path}`
    if (signatures.has(signature)) throw new TypeError(`Duplicate managed OpenAPI operation: ${signature}`)
    signatures.add(signature)
  }
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
