import { describe, expect, it } from 'vitest'
import { githubOperationRequirements } from '../../src/providers/github/openapi-paths.js'
import { resolveGitHubOperationPermissions } from '../../src/providers/github/operation-permissions.js'

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

  it('[spec: github-adapter/github-operation-authority] selects one least-privileged satisfied alternative', () => {
    expect(
      resolveGitHubOperationPermissions({
        method: 'PATCH',
        path: '/repos/realmroot/example/issues/42',
        scopes: new Set(['metadata:read', 'pull_requests:write']),
        available: { issues: 'write', metadata: 'read', pull_requests: 'write' },
      }),
    ).toEqual({ pull_requests: 'write' })

    expect(
      resolveGitHubOperationPermissions({
        method: 'PATCH',
        path: '/repos/realmroot/example/issues/42',
        scopes: new Set(['issues:write', 'pull_requests:write']),
        available: { issues: 'write', pull_requests: 'write' },
      }),
    ).toEqual({ issues: 'write' })
  })

  it('[spec: github-adapter/github-operation-authority] matches slash-delimited Git reference names', () => {
    expect(
      resolveGitHubOperationPermissions({
        method: 'GET',
        path: '/repos/realmroot/example/git/ref/heads/main',
        scopes: new Set(['contents:read']),
        available: { contents: 'write' },
      }),
    ).toEqual({ contents: 'read' })
    expect(
      resolveGitHubOperationPermissions({
        method: 'DELETE',
        path: '/repos/realmroot/example/git/refs/tags/v1.0.0',
        scopes: new Set(['contents:write']),
        available: { contents: 'write' },
      }),
    ).toEqual({ contents: 'write' })
  })

  it('[spec: github-adapter/github-operation-permissions] requires every scope in a conjunction', () => {
    const input = {
      method: 'POST',
      path: '/repos/realmroot/template/generate',
      available: { administration: 'write', contents: 'write' } as const,
    }
    expect(
      resolveGitHubOperationPermissions({
        ...input,
        scopes: new Set(['administration:write', 'contents:write']),
      }),
    ).toEqual({ administration: 'write', contents: 'read' })
    expect(() => resolveGitHubOperationPermissions({ ...input, scopes: new Set(['administration:write']) })).toThrow(
      'Agent token does not grant',
    )
  })

  it('[spec: github-adapter/github-workflow-file-authority] enforces the workflow path condition', () => {
    const input = {
      method: 'PUT',
      available: { contents: 'write', workflows: 'write' } as const,
    }
    expect(
      resolveGitHubOperationPermissions({
        ...input,
        path: '/repos/realmroot/example/contents/README.md',
        scopes: new Set(['contents:write']),
      }),
    ).toEqual({ contents: 'write' })
    expect(
      resolveGitHubOperationPermissions({
        ...input,
        path: '/repos/realmroot/example/contents/.github/workflows',
        scopes: new Set(['contents:write']),
      }),
    ).toEqual({ contents: 'write' })
    expect(() =>
      resolveGitHubOperationPermissions({
        ...input,
        path: '/repos/realmroot/example/contents/.github/workflows/release.yml',
        scopes: new Set(['contents:write']),
      }),
    ).toThrow('Agent token does not grant')
    expect(
      resolveGitHubOperationPermissions({
        ...input,
        path: '/repos/realmroot/example/contents/.github%2Fworkflows%2Frelease.yml',
        scopes: new Set(['contents:write', 'workflows:write']),
      }),
    ).toEqual({ contents: 'write', workflows: 'write' })
  })

  it('[spec: github-adapter/github-workflow-file-authority] leaves workflow file reads unchanged', () => {
    expect(
      resolveGitHubOperationPermissions({
        method: 'GET',
        path: '/repos/realmroot/example/contents/.github/workflows/release.yml',
        scopes: new Set(['contents:read']),
        available: { contents: 'write', workflows: 'write' },
      }),
    ).toEqual({ contents: 'read' })
  })

  it('does not invent a path condition for target-commit-dependent release permissions', () => {
    expect(githubOperationRequirements['post /repos/{owner}/{repo}/releases']).toEqual([
      ['contents:write'],
      ['contents:write', 'workflows:write'],
    ])
    expect(
      resolveGitHubOperationPermissions({
        method: 'POST',
        path: '/repos/realmroot/example/releases',
        scopes: new Set(['contents:write', 'workflows:write']),
        available: { contents: 'write', workflows: 'write' },
      }),
    ).toEqual({ contents: 'write' })
  })
})
