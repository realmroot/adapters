import { describe, expect, it, vi } from 'vitest'
import {
  createGitHubPullRequestWithRest,
  mergeGitHubPullRequestWithRest,
  parseGitHubCreatePullRequest,
  parseGitHubMergePullRequest,
  resolveGitHubPullRequestTarget,
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

  it('recognizes and validates mergePullRequest mutations', () => {
    expect(parseGitHubMergePullRequest(JSON.stringify({ query: 'query { viewer { login } }' }))).toBeNull()
    expect(
      parseGitHubMergePullRequest(
        JSON.stringify({
          query:
            'mutation Merge($input: MergePullRequestInput!) { merged: mergePullRequest(input: $input) { clientMutationId } }',
          variables: { input: { pullRequestId: 'pull-request-1', mergeMethod: 'SQUASH' } },
        }),
      ),
    ).toEqual({
      pullRequestId: 'pull-request-1',
      mergeMethod: 'SQUASH',
      responseField: 'merged',
    })
    expect(() =>
      parseGitHubMergePullRequest(
        JSON.stringify({ query: 'mutation { mergePullRequest(input: {}) { clientMutationId } }' }),
      ),
    ).toThrow('requires one input variable')
    expect(() =>
      parseGitHubMergePullRequest(
        JSON.stringify({
          query:
            'mutation Merge($input: MergePullRequestInput!) { mergePullRequest(input: $input) { clientMutationId } }',
          variables: { input: { pullRequestId: 'pull-request-1', mergeMethod: 'INVALID' } },
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

  it('fails closed on invalid merge lookup and REST responses', async () => {
    await expect(
      resolveGitHubPullRequestTarget({
        provider: fakeProvider(Response.json({ data: { node: null } })),
        token: 'installation-token',
        apiOrigin: 'https://api.github.com',
        pullRequestId: 'pull-request-1',
      }),
    ).rejects.toThrow('could not resolve the pull request target')
    const merge = {
      pullRequestId: 'pull-request-1',
      mergeMethod: 'SQUASH' as const,
      responseField: 'mergePullRequest',
    }
    const conflict = new Response('conflict', { status: 409 })
    await expect(
      mergeGitHubPullRequestWithRest({
        provider: fakeProvider(conflict),
        token: 'installation-token',
        apiOrigin: 'https://api.github.com',
        nameWithOwner: 'realmroot/adapters',
        number: 22,
        pullRequest: merge,
      }),
    ).resolves.toBe(conflict)
    await expect(
      mergeGitHubPullRequestWithRest({
        provider: fakeProvider(Response.json({ merged: false }, { status: 200 })),
        token: 'installation-token',
        apiOrigin: 'https://api.github.com',
        nameWithOwner: 'realmroot/adapters',
        number: 22,
        pullRequest: merge,
      }),
    ).rejects.toThrow('invalid pull request merge response')
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
