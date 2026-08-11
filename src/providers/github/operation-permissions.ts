import { forbidden } from '../../core/problem.js'
import { githubOperationRequirements } from './openapi-paths.js'
import { scopesToPermissions } from './permissions.js'
import type { GitHubPermissionAccess, GitHubPermissions } from './types.js'

const accessRank = { read: 1, write: 2, admin: 3 } as const
const scopePattern = /^([a-z][a-z0-9_]*):(read|write|admin)$/
const operationMatchers = Object.entries(githubOperationRequirements)
  .map(([key, requirements]) => {
    const separator = key.indexOf(' ')
    const method = key.slice(0, separator).toUpperCase()
    const template = key.slice(separator + 1)
    return { method, template, pattern: templatePattern(template), requirements }
  })
  .sort((left, right) => literalLength(right.template) - literalLength(left.template))

export function resolveGitHubOperationPermissions(input: {
  method: string
  path: string
  scopes: ReadonlySet<string>
  available: GitHubPermissions
}) {
  const operation = operationMatchers.find(
    (candidate) => candidate.method === input.method.toUpperCase() && candidate.pattern.test(input.path),
  )
  if (!operation) throw forbidden('The requested GitHub installation operation is not available.')

  const requirements = workflowFileRequirements(
    operation.method,
    operation.template,
    input.path,
    operation.requirements,
  )
  const available = requirements.filter((requirement) =>
    requirement.every((scope) => permissionSatisfies(scope, input.available)),
  )
  if (available.length === 0) {
    throw forbidden('The connected GitHub App does not grant the permissions required for this operation.')
  }
  const satisfied = available
    .filter((requirement) => requirement.every((scope) => scopeSatisfies(scope, input.scopes)))
    .sort(compareRequirements)
  const selected = satisfied[0]
  if (!selected) throw forbidden('The Agent token does not grant the permissions required for this operation.')
  return scopesToPermissions(new Set(selected), input.available)
}

function workflowFileRequirements(
  method: string,
  template: string,
  path: string,
  requirements: readonly (readonly string[])[],
): readonly (readonly string[])[] {
  if (method !== 'PUT' && method !== 'DELETE') return requirements
  if (template !== '/repos/{owner}/{repo}/contents/{path}') return requirements
  const match = /^\/repos\/[^/]+\/[^/]+\/contents\/(.+)$/.exec(path)
  const target = match ? decodeURIComponent(match[1] as string) : ''
  if (!target.startsWith('.github/workflows/')) return requirements
  return [['contents:write', 'workflows:write']]
}

function permissionSatisfies(required: string, permissions: GitHubPermissions) {
  const { permission, access } = parseScope(required)
  const available = permissions[permission]
  return Boolean(available && accessRank[available] >= accessRank[access])
}

function scopeSatisfies(required: string, scopes: ReadonlySet<string>) {
  const expected = parseScope(required)
  return [...scopes].some((scope) => {
    const match = scopePattern.exec(scope)
    if (!match) return false
    const candidate = { permission: match[1], access: match[2] as GitHubPermissionAccess }
    return candidate.permission === expected.permission && accessRank[candidate.access] >= accessRank[expected.access]
  })
}

function parseScope(scope: string): { permission: string; access: GitHubPermissionAccess } {
  const match = scopePattern.exec(scope)
  if (!match) throw forbidden(`The ${scope} scope is not a GitHub App permission.`)
  return { permission: match[1] as string, access: match[2] as GitHubPermissionAccess }
}

function compareRequirements(left: readonly string[], right: readonly string[]) {
  return (
    left.length - right.length ||
    accessCost(left) - accessCost(right) ||
    left.join('\0').localeCompare(right.join('\0'))
  )
}

function accessCost(requirement: readonly string[]) {
  return requirement.reduce((total, scope) => total + accessRank[parseScope(scope).access], 0)
}

function templatePattern(template: string) {
  let source = '^'
  let index = 0
  for (const match of template.matchAll(/\{([^}]+)\}/g)) {
    source += escapeRegex(template.slice(index, match.index))
    source += match[1] === 'path' || match[1] === 'ref' || match[1]?.startsWith('+') ? '.+' : '[^/]+'
    index = (match.index ?? 0) + match[0].length
  }
  source += `${escapeRegex(template.slice(index))}$`
  return new RegExp(source)
}

function escapeRegex(value: string) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

function literalLength(template: string) {
  return template.replace(/\{[^}]+\}/g, '').length
}
