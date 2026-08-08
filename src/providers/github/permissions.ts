import { badRequest, forbidden } from '../../core/problem.js'
import type { GitHubPermissionAccess, GitHubPermissions } from './types.js'

const accessRank = { read: 1, write: 2, admin: 3 } as const
const scopePattern = /^([a-z][a-z0-9_]*):(read|write|admin)$/

export function permissionsToScopes(permissions: GitHubPermissions) {
  return Object.entries(permissions)
    .flatMap(([permission, access]) => accessLevels(access).map((level) => `${permission}:${level}`))
    .sort()
}

export function mergePermissions(values: readonly GitHubPermissions[]): GitHubPermissions {
  const merged: Record<string, GitHubPermissionAccess> = {}
  for (const permissions of values) {
    for (const [permission, access] of Object.entries(permissions)) {
      const current = merged[permission]
      if (!current || accessRank[access] > accessRank[current]) merged[permission] = access
    }
  }
  return merged
}

export function scopesToPermissions(scopes: ReadonlySet<string>, available: GitHubPermissions): GitHubPermissions {
  const requested: Record<string, GitHubPermissionAccess> = {}
  for (const scope of scopes) {
    const match = scopePattern.exec(scope)
    if (!match) throw badRequest(`The ${scope} scope is not a GitHub App permission.`)
    const permission = match[1]
    const access = match[2] as GitHubPermissionAccess
    if (!permission || !available[permission] || accessRank[access] > accessRank[available[permission]]) {
      throw forbidden(`The connected GitHub App does not grant ${scope}.`)
    }
    const current = requested[permission]
    if (!current || accessRank[access] > accessRank[current]) requested[permission] = access
  }
  if (Object.keys(requested).length === 0) throw forbidden('At least one GitHub permission scope is required.')
  return requested
}

function accessLevels(access: GitHubPermissionAccess): GitHubPermissionAccess[] {
  if (access === 'read') return ['read']
  if (access === 'write') return ['read', 'write']
  return ['read', 'write', 'admin']
}
