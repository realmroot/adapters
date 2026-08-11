export class HttpProblem extends Error {
  constructor(
    readonly status: number,
    readonly type: string,
    readonly title: string,
    detail: string,
    readonly headers: Record<string, string> = {},
  ) {
    super(detail)
  }
}

export function unauthorized(detail: string, code = 'invalid_token') {
  return new HttpProblem(401, `urn:realmroot:adapter:${code}`, 'Unauthorized', detail, {
    'WWW-Authenticate': `DPoP error="${code}"`,
  })
}

export function forbidden(detail: string) {
  return new HttpProblem(403, 'urn:realmroot:adapter:insufficient-scope', 'Forbidden', detail)
}

export function insufficientScope(detail: string, alternatives: readonly (readonly string[])[]) {
  const challenges = alternatives
    .filter((scopes) => scopes.length > 0)
    .map((scopes) => [...new Set(scopes)].sort())
    .map((scopes) => `DPoP error="insufficient_scope", scope="${scopes.join(' ')}"`)
  if (challenges.length === 0) return forbidden(detail)
  return new HttpProblem(403, 'urn:realmroot:adapter:insufficient-scope', 'Forbidden', detail, {
    'WWW-Authenticate': challenges.join(', '),
  })
}

export function badRequest(detail: string, type = 'invalid-request') {
  return new HttpProblem(400, `urn:realmroot:adapter:${type}`, 'Bad Request', detail)
}

export function failedDependency(detail: string) {
  return new HttpProblem(424, 'urn:realmroot:adapter:provider-failure', 'Failed Dependency', detail)
}
