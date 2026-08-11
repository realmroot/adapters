import { describe, expect, it, vi } from 'vitest'
import type { AgentPrincipal } from '../../src/core/realmroot-auth.js'
import { transformGitHubRequest } from '../../src/providers/github/transformers.js'

describe('GitHub attribution transformations', () => {
  it('attributes inline GraphQL inputs, body variables, omitted bodies, and root fragments', async () => {
    const inline = await transform(
      graphqlRequest('mutation { createIssue(input: { title: "Inline", body: "Original" }) { issue { id } } }'),
    )
    expect(JSON.parse(String(inline)).query).toContain('Created by [Build Agent]')

    const bodyVariable = await transform(
      graphqlRequest(
        'mutation Create($body: String) { createIssue(input: { title: "Variable", body: $body }) { issue { id } } }',
        { body: 'Original' },
      ),
    )
    expect(JSON.parse(String(bodyVariable)).variables.body).toContain('Created by [Build Agent]')

    const omitted = await transform(
      graphqlRequest(
        'mutation Create { ...CreateIssue } fragment CreateIssue on Mutation { createIssue(input: { title: "No body" }) { issue { id } } }',
      ),
    )
    expect(JSON.parse(String(omitted)).query).toContain('Created by [Build Agent]')
  })

  it('rejects invalid attributed REST and GraphQL body shapes', async () => {
    await expect(
      transform(
        new Request('https://adapter.example/repos/realmroot/example/issues', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: '{',
        }),
        '/repos/realmroot/example/issues',
      ),
    ).rejects.toThrow('valid JSON')

    await expect(
      transform(
        graphqlRequest('mutation Create($input: CreateIssueInput!) { createIssue(input: $input) { issue { id } } }', {
          input: 'invalid',
        }),
      ),
    ).rejects.toThrow('must be an object')
    await expect(
      transform(
        graphqlRequest('mutation Create($input: CreateIssueInput!) { createIssue(input: $input) { issue { id } } }', {
          input: { title: 'Invalid', body: 42 },
        }),
      ),
    ).rejects.toThrow('body must be a string')
    await expect(transform(graphqlRequest('mutation { createIssue(input: null) { issue { id } } }'))).rejects.toThrow(
      'input must be an object or variable',
    )
    await expect(
      transform(graphqlRequest('mutation { createIssue(input: { title: "Invalid", body: 42 }) { issue { id } } }')),
    ).rejects.toThrow('body must be a string or variable')
  })

  it('preserves non-attributed GraphQL traffic and enforces attributed request size limits', async () => {
    const invalid = '{'
    await expect(transform(request(invalid, 'application/json'))).resolves.toBe(invalid)

    const plain = request('plain', 'text/plain')
    const body = await transform(plain)
    expect(await new Response(body).text()).toBe('plain')

    await expect(transform(request('x'.repeat(70_001), 'application/json'))).rejects.toThrow('may not exceed')
    await expect(
      transform(
        new Request('https://adapter.example/graphql', {
          method: 'POST',
          headers: { 'content-type': 'application/json', 'content-length': '70001' },
          body: '{}',
        }),
      ),
    ).rejects.toThrow('may not exceed')
  })
})

async function transform(request: Request, upstreamPath = '/graphql') {
  return transformGitHubRequest({
    request,
    upstreamPath,
    principal,
    agentInfo: {
      resolve: vi.fn(async () => ({
        name: 'Build Agent',
        picture: 'https://id.example/agent.png',
        identityUrl: 'https://id.example/agents/agent-1',
      })),
    },
    requestId: 'request-1',
  })
}

function graphqlRequest(query: string, variables?: Record<string, unknown>) {
  return request(JSON.stringify({ query, variables }), 'application/json')
}

function request(body: string, contentType: string) {
  return new Request('https://adapter.example/graphql', {
    method: 'POST',
    headers: { 'content-type': contentType },
    body,
  })
}

const principal: AgentPrincipal = {
  subject: 'organization-1',
  issuer: 'https://id.example/api/auth',
  actor: { issuer: 'https://id.example/api/auth', subject: 'agent-1', profile: 'ai_agent' },
  scopes: new Set(['issues:write']),
}
