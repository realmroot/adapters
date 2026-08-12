import { createHash } from 'node:crypto'
import { readFile, writeFile } from 'node:fs/promises'

const methods = ['get', 'put', 'post', 'delete', 'patch', 'head', 'options', 'trace']
const source = JSON.parse(await readFile(new URL('../providers/cloudflare/source.json', import.meta.url)))
const overrides = JSON.parse(
  await readFile(new URL('../providers/cloudflare/permission-overrides.json', import.meta.url)),
)
const groupOverrides = JSON.parse(
  await readFile(new URL('../providers/cloudflare/permission-group-overrides.json', import.meta.url)),
)
const wranglerCompatibility = JSON.parse(
  await readFile(new URL('../providers/cloudflare/wrangler-compatibility-operations.json', import.meta.url)),
)
const rawUrl = `https://raw.githubusercontent.com/cloudflare/api-schemas/${source.commit}/openapi.json`
const raw = new Uint8Array(await checkedFetch(rawUrl).then((response) => response.arrayBuffer()))
const sourceHash = sha256(raw)
if (sourceHash !== source.openapiSha256) {
  throw new Error(`Cloudflare OpenAPI SHA-256 mismatch: expected ${source.openapiSha256}, received ${sourceHash}`)
}
const document = JSON.parse(new TextDecoder().decode(raw))
const catalog = await readCatalog()
const catalogHash = sha256(new TextEncoder().encode(JSON.stringify(catalog)))
const catalogByName = Map.groupBy(catalog, (scope) => scope.name)
const operationIds = new Set()
const publishedSourceKeys = new Set()
const routes = []
const exclusions = []
const paths = {}

for (const [path, pathItem] of Object.entries(document.paths)) {
  const runtimePath = normalizeRepeatedPathParameters(path)
  const published = {}
  if (pathItem.parameters) published.parameters = appendRenamedPathParameters(pathItem.parameters, runtimePath.renames)
  for (const method of methods) {
    const operation = pathItem[method]
    if (!operation) continue
    if (!operation.operationId || operationIds.has(operation.operationId)) {
      throw new Error(
        `Cloudflare operationId is missing or duplicated: ${operation.operationId ?? `${method} ${path}`}`,
      )
    }
    operationIds.add(operation.operationId)
    const key = `${method.toUpperCase()} ${path}`
    const resolved = resolveScopes(path, operation['x-api-token-group'], overrides[key], catalogByName, groupOverrides)
    if (resolved.scopes.length === 0) {
      exclusions.push({
        method: method.toUpperCase(),
        path,
        operationId: operation.operationId,
        reason: resolved.reason,
        permissionGroups: operation['x-api-token-group'] ?? null,
      })
      continue
    }
    const cleaned = stripNoise(operation)
    if (cleaned.parameters) {
      cleaned.parameters = appendRenamedPathParameters(cleaned.parameters, runtimePath.renames)
    }
    cleaned.security = resolved.scopes.map((scope) => ({ realmrootOidc: [scope] }))
    published[method] = cleaned
    publishedSourceKeys.add(key)
    routes.push({
      method: method.toUpperCase(),
      path: runtimePath.path,
      operationId: operation.operationId,
      scopes: resolved.scopes,
    })
  }
  if (methods.some((method) => published[method])) paths[runtimePath.path] = published
}

for (const operation of wranglerCompatibility.operations) {
  const method = operation.method.toLowerCase()
  if (!methods.includes(method)) throw new Error(`Invalid Wrangler compatibility method: ${operation.method}`)
  if (operation.officialOperationId) {
    const exclusionIndex = exclusions.findIndex(
      (candidate) =>
        candidate.method === operation.method &&
        candidate.path === operation.path &&
        candidate.operationId === operation.officialOperationId,
    )
    if (exclusionIndex === -1) {
      throw new Error(
        `Wrangler compatibility operation does not replace the declared official exclusion: ${operation.method} ${operation.path}`,
      )
    }
    exclusions.splice(exclusionIndex, 1)
  }
  if (paths[operation.path]?.[method]) {
    throw new Error(
      `Wrangler compatibility operation duplicates the official Cloudflare schema: ${operation.method} ${operation.path}`,
    )
  }
  if (operationIds.has(operation.operationId)) {
    throw new Error(
      `Wrangler compatibility operationId duplicates the official Cloudflare schema: ${operation.operationId}`,
    )
  }
  operationIds.add(operation.operationId)
  paths[operation.path] ??= {}
  paths[operation.path][method] = {
    operationId: operation.operationId,
    parameters: [...operation.path.matchAll(/\{([^}]+)\}/g)].map(([, name]) => ({
      name,
      in: 'path',
      required: true,
      schema: { type: 'string' },
    })),
    responses: { default: {} },
    security: operation.scopes.map((scope) => ({ realmrootOidc: [scope] })),
    'x-realmroot-compatibility-source': {
      package: wranglerCompatibility.package,
      version: wranglerCompatibility.version,
      source: wranglerCompatibility.source,
      ...(operation.officialOperationId ? { officialOperationId: operation.officialOperationId } : {}),
    },
  }
  routes.push({
    method: operation.method,
    path: operation.path,
    operationId: operation.operationId,
    scopes: operation.scopes,
  })
}

for (const key of Object.keys(overrides)) {
  if (!publishedSourceKeys.has(key)) {
    throw new Error(`Unused or invalid Cloudflare permission override: ${key}`)
  }
}

function normalizeRepeatedPathParameters(path) {
  const counts = new Map()
  const renames = []
  const normalized = path.replaceAll(/\{([^}]+)\}/g, (_, name) => {
    const occurrence = (counts.get(name) ?? 0) + 1
    counts.set(name, occurrence)
    if (occurrence === 1) return `{${name}}`
    const target = `${name}_${occurrence}`
    renames.push({ source: name, target })
    return `{${target}}`
  })
  return { path: normalized, renames }
}

function appendRenamedPathParameters(parameters, renames) {
  if (renames.length === 0) return parameters
  const additions = renames.map(({ source, target }) => {
    const parameter = parameters.find((candidate) => candidate.in === 'path' && candidate.name === source)
    if (!parameter) throw new Error(`Repeated OpenAPI path parameter ${source} has no parameter definition.`)
    return { ...parameter, name: target }
  })
  return [...parameters, ...additions]
}
for (const route of routes) {
  for (const scope of route.scopes) {
    if (!catalog.some((entry) => entry.id === scope)) throw new Error(`Unknown Cloudflare OAuth scope: ${scope}`)
  }
}

const slim = stripNoise({
  openapi: document.openapi,
  info: {
    title: 'Cloudflare REST API through Realmroot',
    version: document.info.version,
    description:
      'Fail-closed transparent transport for Cloudflare REST operations whose OAuth scope requirements are proven by the pinned Cloudflare API schema and OAuth scope catalog.',
  },
  servers: [{ url: 'https://adapters.realmroot.dev/cloudflare' }],
  externalDocs: { url: 'https://developers.cloudflare.com/api/' },
  tags: document.tags,
  paths,
  components: {
    ...(document.components ?? {}),
    securitySchemes: {
      realmrootOidc: {
        type: 'openIdConnect',
        openIdConnectUrl: 'https://id.realmroot.dev/api/auth/.well-known/openid-configuration',
        'x-dpop-required': true,
      },
    },
  },
  'x-cloudflare-openapi-source': { ...source, sha256: sourceHash },
  'x-cloudflare-oauth-scope-catalog-sha256': catalogHash,
  'x-wrangler-compatibility': {
    package: wranglerCompatibility.package,
    version: wranglerCompatibility.version,
    source: wranglerCompatibility.source,
  },
  'x-cli-config': { command_layout: 'tags' },
  'x-realmroot-transparent-upstream': 'https://api.cloudflare.com/client/v4',
})
slim.components = referencedComponents(slim, document.components ?? {})
slim.components.securitySchemes = {
  realmrootOidc: {
    type: 'openIdConnect',
    openIdConnectUrl: 'https://id.realmroot.dev/api/auth/.well-known/openid-configuration',
    'x-dpop-required': true,
  },
}
const output = `${JSON.stringify(slim)}\n`
if (Buffer.byteLength(output) >= 20 * 1024 * 1024)
  throw new Error('Slim Cloudflare OpenAPI exceeds 20 MiB project budget.')

await Promise.all([
  writeFile(new URL('../public/cloudflare/openapi.json', import.meta.url), output),
  writeFile(
    new URL('../src/providers/cloudflare/operation-permissions.ts', import.meta.url),
    `// Generated by scripts/sync-cloudflare-openapi.mjs. Do not edit.\nexport type CloudflareOperation = Readonly<{ method: string; path: string; operationId: string; scopes: readonly string[] }>\nexport const cloudflareOperations: readonly CloudflareOperation[] = ${JSON.stringify(routes)}\n`,
  ),
  writeFile(
    new URL('../providers/cloudflare/oauth-scopes.json', import.meta.url),
    `${JSON.stringify({ source: 'GET https://api.cloudflare.com/client/v4/oauth/scopes', sha256: catalogHash, scopes: catalog }, null, 2)}\n`,
  ),
  writeFile(
    new URL('../providers/cloudflare/exclusions.json', import.meta.url),
    `${JSON.stringify({ source, operations: exclusions }, null, 2)}\n`,
  ),
])
console.log(
  JSON.stringify({
    source: source.commit,
    sourceHash,
    catalogHash,
    operations: operationIds.size,
    published: routes.length,
    excluded: exclusions.length,
    openapiBytes: Buffer.byteLength(output),
  }),
)

async function readCatalog() {
  if (process.env.CLOUDFLARE_API_TOKEN) {
    const body = await checkedFetch('https://api.cloudflare.com/client/v4/oauth/scopes', {
      headers: { authorization: `Bearer ${process.env.CLOUDFLARE_API_TOKEN}` },
    }).then((response) => response.json())
    if (body.success !== true || !Array.isArray(body.result))
      throw new Error('Cloudflare returned an invalid OAuth scope catalog.')
    return body.result
      .map(({ id, name, category, scopes }) => ({ id, name, category, scopes }))
      .sort((a, b) => a.id.localeCompare(b.id))
  }
  const snapshot = JSON.parse(await readFile(new URL('../providers/cloudflare/oauth-scopes.json', import.meta.url)))
  return snapshot.scopes
}

function resolveScopes(path, permissionGroups, override, catalogByName, groupOverrides) {
  if (override) return { scopes: [...new Set(override.scopes)].sort(), reason: null }
  if (!Array.isArray(permissionGroups) || permissionGroups.length === 0) {
    return {
      scopes: [],
      reason: 'Cloudflare OpenAPI does not declare an API token permission group; OAuth authority cannot be proven.',
    }
  }
  const scopes = permissionGroups.flatMap(
    (name) => groupOverrides[name]?.scopes ?? selectScope(path, catalogByName.get(name) ?? []),
  )
  return scopes.length
    ? { scopes: [...new Set(scopes)].sort(), reason: null }
    : {
        scopes: [],
        reason:
          'No OAuth scope in the authenticated Cloudflare catalog matches the declared API token permission groups.',
      }
}

function selectScope(path, candidates) {
  if (candidates.length <= 1) return candidates.map((scope) => scope.id)
  const zone = path.startsWith('/zones/') || path === '/zones'
  const selected = candidates.filter((scope) =>
    zone
      ? scope.id === 'zone-access.read' ||
        scope.id === 'zone-access.write' ||
        scope.id === 'zone-access.revoke' ||
        scope.id === 'logs.read' ||
        scope.id === 'logs.write'
      : scope.id.startsWith('account-') ||
        scope.id === 'access.read' ||
        scope.id === 'access.write' ||
        scope.id === 'access.revoke',
  )
  return selected.map((scope) => scope.id)
}

function referencedComponents(document, sourceComponents) {
  const names = new Set()
  let serialized = JSON.stringify(document)
  for (;;) {
    const previous = names.size
    for (const match of serialized.matchAll(/#\/components\/([^/]+)\/([^"~]+)/g)) names.add(`${match[1]}/${match[2]}`)
    if (names.size === previous) break
    serialized = JSON.stringify(
      [...names].map((name) => {
        const [group, key] = name.split('/')
        return sourceComponents[group]?.[key]
      }),
    )
  }
  const result = {}
  for (const name of names) {
    const [group, key] = name.split('/')
    if (!sourceComponents[group]?.[key]) throw new Error(`Missing Cloudflare OpenAPI component: ${name}`)
    result[group] ??= {}
    result[group][key] = stripNoise(sourceComponents[group][key])
  }
  return result
}

function stripNoise(value) {
  if (Array.isArray(value)) return value.map(stripNoise)
  if (!value || typeof value !== 'object') return value
  return Object.fromEntries(
    Object.entries(value)
      .filter(([key]) => !['description', 'example', 'examples', 'externalDocs', 'xml', 'x-stainless'].includes(key))
      .map(([key, item]) => [key, stripNoise(item)]),
  )
}

async function checkedFetch(url, init) {
  const response = await fetch(url, init)
  if (!response.ok) throw new Error(`Cloudflare source request failed with ${response.status}: ${url}`)
  return response
}

function sha256(bytes) {
  return createHash('sha256').update(bytes).digest('hex')
}
