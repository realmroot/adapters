import { z } from 'zod'
import type { AgentInfoResolver } from '../../core/agent-info.js'
import { attributedBody } from '../../core/attribution.js'
import { badRequest } from '../../core/problem.js'
import type { AgentPrincipal } from '../../core/realmroot-auth.js'

const attributedJsonSchema = z.object({ body: z.string().max(65_536).optional() }).passthrough()
const attributionPaths = [
  /^\/repos\/[^/]+\/[^/]+\/issues$/,
  /^\/repos\/[^/]+\/[^/]+\/issues\/\d+\/comments$/,
  /^\/repos\/[^/]+\/[^/]+\/pulls\/\d+\/comments$/,
]

export async function transformGitHubRequest(input: {
  request: Request
  upstreamPath: string
  principal: AgentPrincipal
  agentInfo: AgentInfoResolver
  requestId: string
}) {
  if (input.request.method !== 'POST' || !attributionPaths.some((pattern) => pattern.test(input.upstreamPath))) {
    return input.request.body
  }
  if (!input.request.headers.get('content-type')?.toLowerCase().startsWith('application/json')) {
    throw badRequest('This attributed GitHub operation requires a JSON request body.')
  }
  const contentLength = Number(input.request.headers.get('content-length') ?? 0)
  if (contentLength > 70_000) throw badRequest('The GitHub request body is too large for attribution.')
  let json: unknown
  try {
    json = await input.request.json()
  } catch {
    throw badRequest('The request body must be valid JSON.')
  }
  const body = attributedJsonSchema.parse(json)
  const display = await input.agentInfo.resolve(input.principal)
  return JSON.stringify({
    ...body,
    body: attributedBody(body.body, input.principal, display, input.requestId),
  })
}
