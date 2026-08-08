import { z } from 'zod'
import { failedDependency, HttpProblem } from '../../core/problem.js'
import {
  githubInstallationOperationSource,
  githubInstallationOperations,
  githubOpenApiSource,
  githubOperationScopes,
  githubPermissionSource,
} from './openapi-paths.js'
import type { GitHubPermissionAccess, GitHubPermissions } from './types.js'

const maxOpenApiBytes = 20 * 1024 * 1024
const documentSchema = z.looseObject({
  openapi: z.string().min(1),
  info: z.looseObject({ version: z.string().min(1) }),
  paths: z.record(z.string(), z.record(z.string(), z.unknown())),
  components: z.record(z.string(), z.unknown()).optional(),
})
const methodNames = new Set(['get', 'put', 'post', 'delete', 'options', 'head', 'patch', 'trace'])
const accessRank = { read: 1, write: 2, admin: 3 } as const

export async function githubOpenApi(input: {
  resource: string
  realmrootIssuer: string
  permissions: GitHubPermissions
  response: Response
}) {
  const document = await parseOpenApi(input.response)
  const paths: Record<string, Record<string, unknown>> = {}
  for (const [path, pathItem] of Object.entries(document.paths)) {
    const published: Record<string, unknown> = {}
    for (const [name, value] of Object.entries(pathItem)) {
      if (!methodNames.has(name)) {
        published[name] = value
        continue
      }
      const security = operationSecurity(name, path, input.permissions)
      if (!security || !isObject(value)) continue
      published[name] = {
        ...Object.fromEntries(Object.entries(value).filter(([key]) => key !== 'servers')),
        security,
      }
    }
    if (Object.keys(published).some((name) => methodNames.has(name))) paths[path] = published
  }

  const components = document.components ?? {}
  return {
    ...document,
    info: {
      ...document.info,
      title: 'GitHub REST API through Realmroot',
      description:
        'Transparent proxy for GitHub REST endpoints. Paths, methods, query parameters, request bodies, and responses follow the GitHub REST API.',
    },
    servers: [{ url: input.resource }],
    externalDocs: { url: 'https://docs.github.com/rest' },
    'x-github-openapi-source': githubOpenApiSource,
    'x-github-permission-source': githubPermissionSource,
    'x-github-installation-operation-source': githubInstallationOperationSource,
    'x-realmroot-transparent-upstream': 'https://api.github.com',
    components: {
      ...components,
      securitySchemes: {
        ...(isObject(components.securitySchemes) ? components.securitySchemes : {}),
        realmrootOidc: {
          type: 'openIdConnect',
          openIdConnectUrl: `${input.realmrootIssuer}/.well-known/openid-configuration`,
          'x-dpop-required': true,
        },
      },
    },
    paths,
  }
}

async function parseOpenApi(response: Response) {
  try {
    return documentSchema.parse(await boundedJson(response))
  } catch (error) {
    if (error instanceof HttpProblem) throw error
    throw failedDependency('GitHub returned an invalid OpenAPI document.')
  }
}

function operationSecurity(method: string, path: string, permissions: GitHubPermissions) {
  const key = `${method} ${path}` as keyof typeof githubInstallationOperations
  if (!githubInstallationOperations[key]) return
  const scopes = githubOperationScopes[key as keyof typeof githubOperationScopes] ?? ['metadata:read']
  const available = scopes.filter((scope) => hasPermission(scope, permissions))
  if (available.length === 0) return
  return available.map((scope) => ({ realmrootOidc: [scope] }))
}

function hasPermission(scope: string, permissions: GitHubPermissions) {
  const [permission, requested] = scope.split(':') as [string, GitHubPermissionAccess]
  const available = permissions[permission]
  return Boolean(available && accessRank[available] >= accessRank[requested])
}

async function boundedJson(response: Response) {
  const declaredLength = Number(response.headers.get('content-length'))
  if (Number.isFinite(declaredLength) && declaredLength > maxOpenApiBytes) throw invalidOpenApiSize()
  if (!response.body) throw failedDependency('GitHub returned an empty OpenAPI document.')
  const reader = response.body.getReader()
  const chunks: Uint8Array[] = []
  let size = 0
  while (true) {
    const { done, value } = await reader.read()
    if (done) break
    size += value.byteLength
    if (size > maxOpenApiBytes) {
      await reader.cancel()
      throw invalidOpenApiSize()
    }
    chunks.push(value)
  }
  const bytes = new Uint8Array(size)
  let offset = 0
  for (const chunk of chunks) {
    bytes.set(chunk, offset)
    offset += chunk.byteLength
  }
  return JSON.parse(new TextDecoder().decode(bytes)) as unknown
}

function invalidOpenApiSize() {
  return failedDependency(`GitHub OpenAPI exceeds the ${maxOpenApiBytes} byte adapter limit.`)
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}
