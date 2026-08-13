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

  it.each([
    ['POST', '/repos/realmroot/example/issues'],
    ['PATCH', '/repos/realmroot/example/issues/42'],
    ['POST', '/repos/realmroot/example/issues/42/comments'],
    ['PATCH', '/repos/realmroot/example/issues/comments/7'],
    ['POST', '/repos/realmroot/example/pulls'],
    ['PATCH', '/repos/realmroot/example/pulls/42'],
    ['POST', '/repos/realmroot/example/pulls/42/comments'],
    ['POST', '/repos/realmroot/example/pulls/42/comments/7/replies'],
    ['PATCH', '/repos/realmroot/example/pulls/comments/7'],
    ['POST', '/repos/realmroot/example/pulls/42/reviews/7/events'],
    ['PUT', '/repos/realmroot/example/pulls/42/reviews/7'],
    ['POST', '/repos/realmroot/example/commits/main/comments'],
    ['PATCH', '/repos/realmroot/example/comments/7'],
    ['POST', '/repos/realmroot/example/releases'],
    ['PATCH', '/repos/realmroot/example/releases/7'],
    ['POST', '/orgs/realmroot/projectsV2/42/drafts'],
  ] as const)('attributes REST content sent through %s %s', async (method, path) => {
    const transformed = await transform(restRequest(method, path, { body: 'Original' }), path)
    expect(JSON.parse(String(transformed)).body).toContain('🤖 Created by [Build Agent]')
  })

  it('attributes REST review bodies and every inline review comment', async () => {
    const path = '/repos/realmroot/example/pulls/42/reviews'
    const transformed = await transform(
      restRequest('POST', path, {
        body: 'Review summary',
        comments: [
          { path: 'src/index.ts', line: 10, body: 'First comment' },
          { path: 'src/index.ts', line: 20, body: 'Second comment' },
        ],
      }),
      path,
    )
    const json = JSON.parse(String(transformed))
    expect(json.body).toContain('Created by [Build Agent]')
    expect(json.comments).toHaveLength(2)
    expect(json.comments.every((comment: { body: string }) => comment.body.includes('Created by [Build Agent]'))).toBe(
      true,
    )
  })

  it.each([
    'createIssue',
    'updateIssue',
    'addProjectV2DraftIssue',
    'updateProjectV2DraftIssue',
    'createProjectV2StatusUpdate',
    'updateProjectV2StatusUpdate',
    'createPullRequest',
    'updatePullRequest',
    'revertPullRequest',
    'addComment',
    'createDiscussion',
    'updateDiscussion',
    'addDiscussionComment',
    'updateDiscussionComment',
    'updateIssueComment',
    'addPullRequestReview',
    'submitPullRequestReview',
    'updatePullRequestReview',
    'addPullRequestReviewComment',
    'updatePullRequestReviewComment',
    'addPullRequestReviewThread',
    'addPullRequestReviewThreadReply',
  ])('attributes the GraphQL %s mutation body', async (field) => {
    const transformed = await transform(
      graphqlRequest(`mutation Write($input: ExampleInput!) { ${field}(input: $input) { clientMutationId } }`, {
        input: { body: 'Original' },
      }),
    )
    expect(JSON.parse(String(transformed)).variables.input.body).toContain('Created by [Build Agent]')
  })

  it('attributes GraphQL inline and variable review comments', async () => {
    const variable = await transform(
      graphqlRequest(
        'mutation Review($input: AddPullRequestReviewInput!) { addPullRequestReview(input: $input) { clientMutationId } }',
        { input: { comments: [{ path: 'src/index.ts', line: 10, body: 'Variable comment' }] } },
      ),
    )
    expect(JSON.parse(String(variable)).variables.input.comments[0].body).toContain('Created by [Build Agent]')

    const inline = await transform(
      graphqlRequest(
        'mutation { addPullRequestReview(input: { comments: [{ path: "src/index.ts", line: 10, body: "Inline comment" }] }) { clientMutationId } }',
      ),
    )
    expect(JSON.parse(String(inline)).query).toContain('Created by [Build Agent]')
  })

  it('does not invent a body for REST or GraphQL update operations without content', async () => {
    const path = '/repos/realmroot/example/pulls/42'
    const rest = await transform(restRequest('PATCH', path, { state: 'closed' }), path)
    expect(String(rest)).toBe(JSON.stringify({ state: 'closed' }))

    const graphql = await transform(
      graphqlRequest(
        'mutation Update($input: ExampleInput!) { updatePullRequest(input: $input) { clientMutationId } }',
        {
          input: { pullRequestId: 'PR_1', state: 'CLOSED' },
        },
      ),
    )
    expect(JSON.parse(String(graphql)).variables.input).toEqual({ pullRequestId: 'PR_1', state: 'CLOSED' })
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

function restRequest(method: string, path: string, body: Record<string, unknown>) {
  return new Request(`https://adapter.example${path}`, {
    method,
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  })
}

const principal: AgentPrincipal = {
  subject: 'organization-1',
  issuer: 'https://id.example/api/auth',
  actor: { issuer: 'https://id.example/api/auth', subject: 'agent-1', profile: 'ai_agent' },
  scopes: new Set(['issues:write']),
}
