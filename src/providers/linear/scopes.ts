export const linearScopes = [
  'read',
  'write',
  'issues:create',
  'comments:create',
  'timeSchedule:write',
  'app:assignable',
  'app:mentionable',
  'customer:read',
  'customer:write',
  'initiative:read',
  'initiative:write',
] as const

export type LinearScope = (typeof linearScopes)[number]

export const linearScopeDescriptions: Readonly<Record<LinearScope, string>> = {
  read: 'Read Linear workspace data.',
  write: 'Write Linear workspace data.',
  'issues:create': 'Create Linear issues and attachments.',
  'comments:create': 'Create Linear issue comments.',
  'timeSchedule:write': 'Create and modify Linear time schedules.',
  'app:assignable': 'Allow the Linear App user to be delegated issues and projects.',
  'app:mentionable': 'Allow the Linear App user to be mentioned in Linear editor surfaces.',
  'customer:read': 'Read Linear customer data.',
  'customer:write': 'Write Linear customer data.',
  'initiative:read': 'Read Linear initiative data.',
  'initiative:write': 'Write Linear initiative data.',
}

const supported = new Set<string>(linearScopes)

export function parseLinearScopes(value: string | readonly string[]) {
  const values = (typeof value === 'string' ? value.split(/[\s,]+/) : value).filter(Boolean)
  const unique = [...new Set(values)]
  const unsupported = unique.find((scope) => !supported.has(scope))
  if (unsupported) throw new TypeError(`Unsupported Linear scope: ${unsupported}`)
  return unique as LinearScope[]
}

export function appAuthorizationScopes(requested: readonly string[]) {
  const scopes = parseLinearScopes(requested)
  return scopes.includes('read') ? scopes : (['read', ...scopes] as LinearScope[])
}
