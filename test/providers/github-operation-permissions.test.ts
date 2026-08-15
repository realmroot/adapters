import { describe, expect, it } from 'vitest'
import { HttpProblem } from '../../src/core/problem.js'
import { githubOperationRequirements } from '../../src/providers/github/openapi-paths.js'
import { authorizeGitHubOperation } from '../../src/providers/github/operation-permissions.js'

describe('GitHub operation permissions', () => {
  it('[spec: github-adapter/github-operation-permissions] generates alternatives and conjunctions from structured docs', () => {
    expect(githubOperationRequirements['patch /repos/{owner}/{repo}/issues/{issue_number}']).toEqual([
      ['issues:write'],
      ['pull_requests:write'],
    ])
    expect(githubOperationRequirements['post /repos/{template_owner}/{template_repo}/generate']).toEqual([
      ['administration:write', 'contents:read'],
    ])
  })

  it('[spec: github-adapter/github-operation-authority] accepts any satisfied permission alternative', () => {
    expect(
      authorizeGitHubOperation({
        method: 'PATCH',
        path: '/repos/realmroot/example/issues/42',
        scopes: new Set(['metadata:read', 'pull_requests:write']),
        available: { issues: 'write', metadata: 'read', pull_requests: 'write' },
      }),
    ).toBeUndefined()

    expect(
      authorizeGitHubOperation({
        method: 'PATCH',
        path: '/repos/realmroot/example/issues/42',
        scopes: new Set(['issues:write', 'pull_requests:write']),
        available: { issues: 'write', pull_requests: 'write' },
      }),
    ).toBeUndefined()
  })

  it('[spec: github-adapter/github-operation-authority] accepts repository-domain authority alongside metadata', () => {
    expect(
      authorizeGitHubOperation({
        method: 'GET',
        path: '/repos/saltbo/wakatoken/pulls',
        scopes: new Set(['metadata:read', 'pull_requests:write']),
        available: { metadata: 'read', pull_requests: 'write' },
      }),
    ).toBeUndefined()
  })

  it('[spec: github-adapter/github-native-tool-scope-challenge] reports every available scope alternative', () => {
    try {
      authorizeGitHubOperation({
        method: 'PATCH',
        path: '/repos/realmroot/example/issues/42',
        scopes: new Set(['metadata:read']),
        available: { issues: 'write', metadata: 'read', pull_requests: 'write' },
      })
      throw new Error('expected insufficient scope')
    } catch (error) {
      expect(error).toBeInstanceOf(HttpProblem)
      expect((error as HttpProblem).headers['WWW-Authenticate']).toBe(
        'DPoP error="insufficient_scope", scope="issues:write", DPoP error="insufficient_scope", scope="pull_requests:write"',
      )
    }
  })

  it('[spec: github-adapter/github-operation-authority] matches slash-delimited Git reference names', () => {
    expect(
      authorizeGitHubOperation({
        method: 'GET',
        path: '/repos/realmroot/example/git/ref/heads/main',
        scopes: new Set(['contents:read']),
        available: { contents: 'write' },
      }),
    ).toBeUndefined()
    expect(
      authorizeGitHubOperation({
        method: 'DELETE',
        path: '/repos/realmroot/example/git/refs/tags/v1.0.0',
        scopes: new Set(['contents:write']),
        available: { contents: 'write' },
      }),
    ).toBeUndefined()
  })

  it('[spec: github-adapter/github-operation-permissions] requires every scope in a conjunction', () => {
    const input = {
      method: 'POST',
      path: '/repos/realmroot/template/generate',
      available: { administration: 'write', contents: 'write' } as const,
    }
    expect(
      authorizeGitHubOperation({
        ...input,
        scopes: new Set(['administration:write', 'contents:write']),
      }),
    ).toBeUndefined()
    expect(() => authorizeGitHubOperation({ ...input, scopes: new Set(['administration:write']) })).toThrow(
      'Agent token does not grant',
    )
  })

  it('[spec: github-adapter/github-workflow-file-authority] enforces the workflow path condition', () => {
    const input = {
      method: 'PUT',
      available: { contents: 'write', workflows: 'write' } as const,
    }
    expect(
      authorizeGitHubOperation({
        ...input,
        path: '/repos/realmroot/example/contents/README.md',
        scopes: new Set(['contents:write']),
      }),
    ).toBeUndefined()
    expect(
      authorizeGitHubOperation({
        ...input,
        path: '/repos/realmroot/example/contents/.github/workflows',
        scopes: new Set(['contents:write']),
      }),
    ).toBeUndefined()
    expect(() =>
      authorizeGitHubOperation({
        ...input,
        path: '/repos/realmroot/example/contents/.github/workflows/release.yml',
        scopes: new Set(['contents:write']),
      }),
    ).toThrow('Agent token does not grant')
    expect(
      authorizeGitHubOperation({
        ...input,
        path: '/repos/realmroot/example/contents/.github%2Fworkflows%2Frelease.yml',
        scopes: new Set(['contents:write', 'workflows:write']),
      }),
    ).toBeUndefined()
  })

  it('[spec: github-adapter/github-workflow-file-authority] leaves workflow file reads unchanged', () => {
    expect(
      authorizeGitHubOperation({
        method: 'GET',
        path: '/repos/realmroot/example/contents/.github/workflows/release.yml',
        scopes: new Set(['contents:read']),
        available: { contents: 'write', workflows: 'write' },
      }),
    ).toBeUndefined()
  })

  it('does not invent a path condition for target-commit-dependent release permissions', () => {
    expect(githubOperationRequirements['post /repos/{owner}/{repo}/releases']).toEqual([
      ['contents:write'],
      ['contents:write', 'workflows:write'],
    ])
    expect(
      authorizeGitHubOperation({
        method: 'POST',
        path: '/repos/realmroot/example/releases',
        scopes: new Set(['contents:write', 'workflows:write']),
        available: { contents: 'write', workflows: 'write' },
      }),
    ).toBeUndefined()
  })
})
