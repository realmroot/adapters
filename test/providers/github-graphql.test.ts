import { describe, expect, it, vi } from 'vitest'
import {
  createGitHubPullRequestWithRest,
  parseGitHubCreatePullRequest,
  resolveGitHubRepositoryName,
} from '../../src/providers/github/graphql.js'
import type { GitHubProvider } from '../../src/providers/github/types.js'

describe('GitHub GraphQL compatibility', () => {
  it('recognizes only one createPullRequest mutation and preserves its response alias', () => {
    expect(parseGitHubCreatePullRequest(null)).toBeNull()
    expect(parseGitHubCreatePullRequest('{')).toBeNull()
    expect(parseGitHubCreatePullRequest(JSON.stringify({ query: 'query { viewer { login } }' }))).toBeNull()
    expect(
      parseGitHubCreatePullRequest(
        JSON.stringify({ query: 'mutation { createIssue(input: { title: "x" }) { issue { id } } }' }),
      ),
    ).toBeNull()
    expect(
      parseGitHubCreatePullRequest(
        JSON.stringify({
          query:
            'mutation Create($input: CreatePullRequestInput!) { created: createPullRequest(input: $input) { pullRequest { id } } }',
          variables: {
            input: {
              repositoryId: 'repository-1',
              baseRefName: 'main',
              headRefName: 'feature',
              title: 'Feature',
            },
          },
        }),
      ),
    ).toEqual({
      repositoryId: 'repository-1',
      baseRefName: 'main',
      headRefName: 'feature',
      title: 'Feature',
      responseField: 'created',
    })
  })

  it('rejects a recognized createPullRequest mutation with an unsupported input shape', () => {
    expect(() =>
      parseGitHubCreatePullRequest(
        JSON.stringify({ query: 'mutation { createPullRequest(input: {}) { pullRequest { id } } }' }),
      ),
    ).toThrow('requires one input variable')
    expect(() =>
      parseGitHubCreatePullRequest(
        JSON.stringify({
          query:
            'mutation Create($input: CreatePullRequestInput!) { createPullRequest(input: $input) { pullRequest { id } } }',
          variables: { input: { title: 'Missing repository' } },
        }),
      ),
    ).toThrow('input is invalid')
  })

  it('fails closed when the repository lookup response is invalid', async () => {
    const provider = fakeProvider(new Response(null, { status: 502 }))
    await expect(
      resolveGitHubRepositoryName({
        provider,
        token: 'installation-token',
        apiOrigin: 'https://api.github.com',
        repositoryId: 'repository-1',
      }),
    ).rejects.toThrow('could not resolve')
  })

  it('preserves REST failures and validates successful pull request responses', async () => {
    const pullRequest = {
      repositoryId: 'repository-1',
      baseRefName: 'main',
      headRefName: 'feature',
      title: 'Feature',
      responseField: 'createPullRequest',
    }
    const denied = new Response('denied', { status: 403 })
    await expect(
      createGitHubPullRequestWithRest({
        provider: fakeProvider(denied),
        token: 'installation-token',
        apiOrigin: 'https://api.github.com',
        nameWithOwner: 'realmroot/adapters',
        pullRequest,
      }),
    ).resolves.toBe(denied)
    await expect(
      createGitHubPullRequestWithRest({
        provider: fakeProvider(Response.json({ id: 1 }, { status: 201 })),
        token: 'installation-token',
        apiOrigin: 'https://api.github.com',
        nameWithOwner: 'realmroot/adapters',
        pullRequest,
      }),
    ).rejects.toThrow('invalid pull request response')
  })
})

function fakeProvider(response: Response): GitHubProvider {
  return {
    appPermissions: vi.fn(),
    openApiDocument: vi.fn(),
    installationToken: vi.fn(),
    request: vi.fn(async () => response),
  }
}
