import { createHmac } from 'node:crypto'
import { readdir, readFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it, vi } from 'vitest'
import { createApp } from '../src/app.js'
import { createGitHubAdapter, type GitHubAdapterDependencies } from '../src/providers/github/adapter.js'
import type { GitHubAdapterConfig } from '../src/providers/github/config.js'
import type { GitHubConnectionStore } from '../src/providers/github/connections.js'
import type { GitHubProvider } from '../src/providers/github/types.js'

const config: GitHubAdapterConfig = {
  origin: 'http://127.0.0.1:4103',
  realmrootIssuer: 'http://127.0.0.1:4189/api/auth',
  realmrootJwksUrl: 'http://127.0.0.1:4189/api/auth/jwks',
  githubApiOrigin: 'https://api.github.com',
  githubUploadsOrigin: 'https://uploads.github.com',
  githubGitOrigin: 'https://github.com',
  githubAppId: '123',
}

const principal = {
  subject: 'org_1',
  issuer: config.realmrootIssuer,
  actor: { issuer: config.realmrootIssuer, subject: 'agt_1', profile: 'ai_agent' as const },
  scopes: new Set(['metadata:read', 'issues:write']),
  connectionId: 'connection-1',
  authorizationDetails: [{ type: 'github_installation', installation_id: '42' }],
}

describe('GitHub adapter contract', () => {
  it('[spec: github-adapter/github-contract] publishes the GitHub Resource Server and provider scopes', async () => {
    const metadata = await testApp().request('/.well-known/oauth-protected-resource/github')
    expect(await metadata.json()).toMatchObject({
      resource: 'http://127.0.0.1:4103/github',
      authorization_servers: [config.realmrootIssuer],
      scopes_supported: [
        'contents:read',
        'contents:write',
        'issues:read',
        'issues:write',
        'metadata:read',
        'pull_requests:read',
        'pull_requests:write',
      ],
      account_connection_modes_supported: ['brokered'],
      account_connection_authorization_details_endpoint:
        'http://127.0.0.1:4103/github/account-connection-authorization-details',
    })
    const resource = await testApp().request('/github')
    expect(resource.headers.get('link')).toContain('rel="service-desc"')
    const contract = (await (await testApp().request('/github/openapi.json')).json()) as {
      paths: Record<string, unknown>
      servers: Array<{ url: string }>
    }
    expect(contract.servers[0]?.url).toBe('http://127.0.0.1:4103/github')
    expect(contract.paths).toHaveProperty('/installation/repositories')
    expect(contract.paths).toHaveProperty('/repos/{owner}/{repo}/issues')
    expect(contract.paths).not.toHaveProperty('/applications/{client_id}/token')
    expect(contract.paths).toMatchObject({
      '/installation/repositories': {
        get: { security: [{ realmrootOidc: ['metadata:read'] }] },
      },
      '/repos/{owner}/{repo}/issues': {
        parameters: [{ name: 'owner', in: 'path' }],
        get: { security: [{ realmrootOidc: ['issues:read'] }, { realmrootOidc: ['metadata:read'] }] },
        post: { security: [{ realmrootOidc: ['issues:write'] }] },
      },
    })
    expect(
      (contract.paths['/repos/{owner}/{repo}/issues'] as { post: { servers?: unknown } }).post.servers,
    ).toBeUndefined()
  })

  it('[spec: github-adapter/github-native-tool-discovery] advertises Git and GitHub CLI integrations', async () => {
    const app = testApp()
    const response = await app.request('/github')
    await expect(response.json()).resolves.toMatchObject({
      toolIntegrations: [
        { id: 'git', executables: ['git'], protocol: 'git-smart-http' },
        { id: 'gh', executables: ['gh'], protocol: 'github-http' },
      ],
    })
    const manifest = await app.request('/providers/github/manifest')
    await expect(manifest.json()).resolves.toMatchObject({
      operations: {
        transformations: expect.arrayContaining([
          { method: 'POST', path: '/repos/{owner}/{repo}/issues', behavior: 'agent-attribution' },
          { method: 'POST', path: '/graphql', behavior: 'agent-attribution' },
        ]),
      },
    })
  })

  it('[spec: github-adapter/github-context-catalog] describes connected installations without credentials', async () => {
    const connections = fakeConnections()
    const response = await testApp({ connections }).request(
      '/github/account-connection-authorization-details?limit=100&offset=0',
      { headers: { Authorization: 'Bearer broker-reference-1' } },
    )

    expect(response.status).toBe(200)
    expect(response.headers.get('cache-control')).toBe('no-store')
    await expect(response.json()).resolves.toEqual({
      items: [
        {
          authorizationDetail: {
            type: 'github_installation',
            installation_id: '42',
            account_login: 'realmroot',
            target_type: 'Organization',
            repository_selection: 'all',
          },
          display: {
            label: 'realmroot',
            description: 'Organization GitHub App installation',
            metadata: { accountType: 'Organization', repositories: 'All repositories' },
          },
        },
      ],
      pagination: { limit: 100, offset: 0, total: 1, hasMore: false, nextOffset: null },
    })
    expect(connections.activeInstallationsForReference).toHaveBeenCalledWith('broker-reference-1')

    const unauthorized = await testApp({ connections }).request('/github/account-connection-authorization-details')
    expect(unauthorized.status).toBe(403)
  })

  it('[spec: github-adapter/github-native-tool-scope-challenge] rejects before GitHub and reports required authority', async () => {
    const provider = fakeProvider()
    const app = testApp({
      provider,
      authenticator: {
        authenticate: vi.fn(async () => ({ ...principal, scopes: new Set(['metadata:read']) })),
      },
    })

    const response = await app.request('/github/repos/realmroot/example/issues', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ title: 'Not authorized' }),
    })

    expect(response.status).toBe(403)
    expect(response.headers.get('www-authenticate')).toBe('DPoP error="insufficient_scope", scope="issues:write"')
    expect(provider.installationToken).not.toHaveBeenCalled()
    expect(provider.request).not.toHaveBeenCalled()
  })

  it('[spec: github-adapter/github-graphql-proxy] forwards GraphQL with approved installation permissions', async () => {
    const provider = fakeProvider()
    provider.request = vi.fn(async (request: Request, token: string, mode) => {
      expect(request.url).toBe('https://api.github.com/graphql')
      expect(token).toBe('installation-secret')
      expect(mode).toBeUndefined()
      await expect(request.json()).resolves.toEqual({ query: 'query { viewer { login } }' })
      return Response.json({ data: { viewer: { login: 'realmroot-app' } } })
    })
    const response = await testApp({ provider }).request('/github/graphql', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ query: 'query { viewer { login } }' }),
    })
    expect(response.status).toBe(200)
    expect(provider.installationToken).toHaveBeenCalledWith({
      installationId: 42,
      permissions: { issues: 'write', metadata: 'read' },
    })
  })

  it('[spec: github-adapter/github-graphql-proxy] preserves the GitHub CLI createPullRequest mutation', async () => {
    const provider = fakeProvider()
    provider.request = vi
      .fn()
      .mockImplementationOnce(async (request: Request, token: string) => {
        expect(request.url).toBe('https://api.github.com/graphql')
        expect(token).toBe('installation-secret')
        await expect(request.json()).resolves.toMatchObject({ variables: { id: 'repository-1' } })
        return Response.json({ data: { node: { nameWithOwner: 'realmroot/example' } } })
      })
      .mockImplementationOnce(async (request: Request, token: string) => {
        expect(request.url).toBe('https://api.github.com/repos/realmroot/example/pulls')
        expect(token).toBe('installation-secret')
        await expect(request.json()).resolves.toEqual({
          title: 'Fix adapter',
          head: 'codex/fix',
          base: 'main',
          body: 'Details',
          draft: true,
          maintainer_can_modify: true,
        })
        return Response.json({ node_id: 'pull-request-1', html_url: 'https://github.test/pull/1' }, { status: 201 })
      })
    const response = await testApp({
      provider,
      authenticator: {
        authenticate: vi.fn(async () => ({
          ...principal,
          scopes: new Set(['metadata:read', 'pull_requests:write']),
        })),
      },
    }).request('/github/graphql', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json; charset=utf-8' },
      body: JSON.stringify({
        query:
          'mutation PullRequestCreate($input: CreatePullRequestInput!) { createPullRequest(input: $input) { pullRequest { id url } } }',
        variables: {
          input: {
            repositoryId: 'repository-1',
            baseRefName: 'main',
            headRefName: 'codex/fix',
            title: 'Fix adapter',
            body: 'Details',
            draft: true,
            maintainerCanModify: true,
          },
        },
      }),
    })

    expect(response.status).toBe(200)
    await expect(response.json()).resolves.toMatchObject({
      data: { createPullRequest: { pullRequest: { url: 'https://github.test/pull/1' } } },
    })
    expect(provider.installationToken).toHaveBeenNthCalledWith(1, {
      installationId: 42,
      permissions: { metadata: 'read' },
    })
    expect(provider.installationToken).toHaveBeenNthCalledWith(2, {
      installationId: 42,
      permissions: { pull_requests: 'write' },
      repositories: ['example'],
    })
  })

  it('[spec: github-adapter/github-graphql-proxy] preserves the GitHub CLI mergePullRequest mutation', async () => {
    const provider = fakeProvider()
    provider.request = vi
      .fn()
      .mockImplementationOnce(async (request: Request) => {
        expect(request.url).toBe('https://api.github.com/graphql')
        await expect(request.json()).resolves.toMatchObject({ variables: { id: 'pull-request-1' } })
        return Response.json({
          data: { node: { number: 22, repository: { nameWithOwner: 'realmroot/example' } } },
        })
      })
      .mockImplementationOnce(async (request: Request) => {
        expect(request.url).toBe('https://api.github.com/repos/realmroot/example/pulls/22/merge')
        await expect(request.json()).resolves.toEqual({ merge_method: 'squash' })
        return Response.json({ sha: 'merge-commit', merged: true }, { status: 200 })
      })
    const response = await testApp({
      provider,
      authenticator: {
        authenticate: vi.fn(async () => ({
          ...principal,
          scopes: new Set(['metadata:read', 'pull_requests:write']),
        })),
      },
    }).request('/github/graphql', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        query:
          'mutation PullRequestMerge($input: MergePullRequestInput!) { mergePullRequest(input: $input) { clientMutationId } }',
        variables: { input: { pullRequestId: 'pull-request-1', mergeMethod: 'SQUASH' } },
      }),
    })

    expect(response.status).toBe(200)
    await expect(response.json()).resolves.toEqual({
      data: { mergePullRequest: { clientMutationId: null } },
    })
    expect(provider.installationToken).toHaveBeenNthCalledWith(2, {
      installationId: 42,
      permissions: { pull_requests: 'write' },
      repositories: ['example'],
    })
  })

  it('[spec: github-adapter/github-git-transport] constrains Smart HTTP fetch and push to repository authority', async () => {
    const provider = fakeProvider()
    provider.request = vi.fn(async (request: Request, _token: string, mode) => {
      expect(mode).toBe('git')
      return new Response(request.url.includes('receive') ? 'push' : 'fetch')
    })
    const authenticated = {
      authenticate: vi.fn(async () => ({ ...principal, scopes: new Set(['contents:read', 'contents:write']) })),
    }
    const app = testApp({ provider, authenticator: authenticated })
    const fetchResponse = await app.request('/github/git/realmroot/example.git/info/refs?service=git-upload-pack')
    expect(fetchResponse.status).toBe(200)
    expect(provider.installationToken).toHaveBeenLastCalledWith({
      installationId: 42,
      permissions: { contents: 'read' },
      repositories: ['example'],
    })
    const pushResponse = await app.request('/github/git/realmroot/example.git/git-receive-pack', {
      method: 'POST',
      body: 'pack',
    })
    expect(pushResponse.status).toBe(200)
    expect(provider.installationToken).toHaveBeenLastCalledWith({
      installationId: 42,
      permissions: { contents: 'write' },
      repositories: ['example'],
    })
  })

  it('[spec: github-adapter/github-permission-translation] returns permissions as scopes and resources as authorization details', async () => {
    const connections = fakeConnections()
    connections.exchange = vi.fn(async () => ({
      intent: intent('completed'),
      brokerReference: 'broker-1',
      binding: {
        githubUserId: 7,
        githubLogin: 'controller',
        displayName: 'Controller',
        scopesJson: '["issues:read","issues:write","metadata:read"]',
      },
      contexts: [
        {
          installationId: 42,
          accountLogin: 'realmroot',
          targetType: 'Organization',
          scopes: ['issues:read', 'issues:write', 'metadata:read'],
          repositorySelection: 'all' as const,
          repositories: [],
        },
      ],
    }))
    const response = await testApp({ connections }).request('/github/account-connection-credentials', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ code: 'code', code_verifier: 'verifier', connection_id: 'request-1' }),
    })
    expect(await response.json()).toEqual({
      external_subject: '7',
      display_name: 'Controller',
      broker_reference: 'broker-1',
      scope: 'issues:read issues:write metadata:read',
      authorization_details: [
        {
          type: 'github_installation',
          installation_id: '42',
          account_login: 'realmroot',
          target_type: 'Organization',
          repository_selection: 'all',
        },
      ],
    })
  })

  it('reports an invalid upstream GitHub OpenAPI document as a dependency failure', async () => {
    const provider = fakeProvider()
    provider.openApiDocument = vi.fn(async () => Response.json({ invalid: true }))
    const response = await testApp({ provider }).request('/github/openapi.json')
    expect(response.status).toBe(424)
    expect(await response.json()).toMatchObject({
      type: 'urn:realmroot:adapter:provider-failure',
      detail: 'GitHub returned an invalid OpenAPI document.',
    })
  })

  it('rejects a GitHub OpenAPI document larger than the bounded discovery response', async () => {
    const provider = fakeProvider()
    provider.openApiDocument = vi.fn(
      async () => new Response('{}', { headers: { 'Content-Length': String(20 * 1024 * 1024 + 1) } }),
    )
    const response = await testApp({ provider }).request('/github/openapi.json')
    expect(response.status).toBe(424)
    expect(await response.json()).toMatchObject({
      detail: 'GitHub OpenAPI exceeds the 20971520 byte adapter limit.',
    })
  })

  it('[spec: github-adapter/github-transparent-proxy] preserves the GitHub request and response', async () => {
    const provider = fakeProvider()
    const request = vi.fn(async (upstream: Request, token: string) => {
      expect(token).toBe('installation-secret')
      expect(upstream.url).toBe('https://api.github.com/repos/realmroot/example/labels/bug?per_page=7')
      expect(upstream.method).toBe('PATCH')
      expect(upstream.headers.get('accept')).toBe('application/vnd.github+json')
      expect(await upstream.json()).toEqual({ name: 'agent-ready', color: '123456' })
      return new Response(JSON.stringify({ id: 9 }), {
        status: 200,
        headers: { 'Content-Type': 'application/json', 'X-GitHub-Request-Id': 'github-1' },
      })
    })
    provider.request = request
    const response = await testApp({ provider }).request('/github/repos/realmroot/example/labels/bug?per_page=7', {
      method: 'PATCH',
      headers: { Accept: 'application/vnd.github+json', 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: 'agent-ready', color: '123456' }),
    })
    expect(response.status).toBe(200)
    expect(response.headers.get('x-github-request-id')).toBe('github-1')
    expect(await response.json()).toEqual({ id: 9 })
    expect(provider.installationToken).toHaveBeenCalledWith({
      installationId: 42,
      permissions: { issues: 'write' },
      repositories: ['example'],
    })
  })

  it('[spec: github-adapter/github-operation-authority] constrains minting to the selected installation context', async () => {
    const provider = fakeProvider()
    const connections = fakeConnections()
    connections.activeInstallationsForOwner = vi.fn(async () => [
      {
        installationId: 42,
        accountLogin: 'realmroot',
        targetType: 'Organization',
        scopes: ['metadata:read'],
        repositorySelection: 'all' as const,
        repositories: [],
      },
    ])
    const response = await testApp({ provider, connections }).request('/github/repos/realmroot/example/labels/bug', {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ color: '123456' }),
    })
    expect(response.status).toBe(403)
    expect(provider.installationToken).not.toHaveBeenCalled()
  })

  it('[spec: github-adapter/github-operation-authority] rejects a token for a replaced broker connection', async () => {
    const provider = fakeProvider()
    const connections = fakeConnections()
    connections.activeInstallationsForOwner = vi.fn(async (_ownerSubject, brokerReference) =>
      brokerReference === 'connection-2'
        ? [
            {
              installationId: 42,
              accountLogin: 'realmroot',
              targetType: 'Organization',
              scopes: ['issues:read', 'issues:write', 'metadata:read'],
              repositorySelection: 'all' as const,
              repositories: [],
            },
          ]
        : [],
    )
    const response = await testApp({ provider, connections }).request('/github/repos/realmroot/example/labels/bug', {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ color: '123456' }),
    })
    expect(response.status).toBe(403)
    expect(connections.activeInstallationsForOwner).toHaveBeenCalledWith('org_1', 'connection-1')
    expect(provider.installationToken).not.toHaveBeenCalled()
  })

  it('[spec: github-adapter/github-installation-resources] rejects repositories removed from selected authority', async () => {
    const provider = fakeProvider()
    const connections = fakeConnections()
    connections.activeInstallationsForOwner = vi.fn(async () => [
      {
        installationId: 42,
        accountLogin: 'realmroot',
        targetType: 'Organization',
        scopes: ['issues:read', 'issues:write', 'metadata:read'],
        repositorySelection: 'selected' as const,
        repositories: [{ id: 7, fullName: 'realmroot/allowed' }],
      },
    ])
    const response = await testApp({ provider, connections }).request('/github/repos/realmroot/removed/issues', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ title: 'Denied' }),
    })
    expect(response.status).toBe(403)
    expect(provider.installationToken).not.toHaveBeenCalled()
  })

  it('keeps release asset uploads behind the adapter and forwards them to GitHub uploads', async () => {
    const provider = fakeProvider()
    provider.request = vi.fn(async (upstream: Request) => {
      expect(upstream.url).toBe('https://uploads.github.com/repos/realmroot/example/releases/7/assets?name=app.zip')
      return Response.json({ id: 9 }, { status: 201 })
    })
    const response = await testApp({
      provider,
      authenticator: {
        authenticate: vi.fn(async () => ({ ...principal, scopes: new Set(['contents:write']) })),
      },
    }).request('/github/repos/realmroot/example/releases/7/assets?name=app.zip', { method: 'POST', body: 'archive' })
    expect(response.status).toBe(201)
  })

  it('[spec: github-adapter/github-create-issue] injects attribution without changing GitHub response semantics', async () => {
    const provider = fakeProvider()
    provider.request = vi.fn(async (upstream: Request) => {
      const input = (await upstream.json()) as { title: string; labels: string[]; body: string }
      expect(input.title).toBe('Adapter test')
      expect(input.labels).toEqual(['adapter'])
      expect(input.body).toContain('Created by [Build Agent]')
      expect(input.body).toContain('<!-- realmroot-agent:')
      return new Response(JSON.stringify({ id: 1, number: 2 }), {
        status: 201,
        headers: { Location: 'https://api.github.com/repos/realmroot/example/issues/2' },
      })
    })
    const response = await testApp({ provider }).request('/github/repos/realmroot/example/issues', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ title: 'Adapter test', labels: ['adapter'], body: 'Original' }),
    })
    expect(response.status).toBe(201)
    expect(response.headers.get('location')).toContain('/issues/2')
    expect(await response.json()).toEqual({ id: 1, number: 2 })
  })

  it('[spec: github-adapter/github-create-issue] injects attribution into GitHub CLI GraphQL issue creation', async () => {
    const provider = fakeProvider()
    provider.request = vi.fn(async (upstream: Request) => {
      expect(upstream.url).toBe('https://api.github.com/graphql')
      const input = (await upstream.json()) as {
        query: string
        variables: { input: { repositoryId: string; title: string; body: string } }
      }
      expect(input.query).toContain('mutation IssueCreate')
      expect(input.variables.input.repositoryId).toBe('repository-1')
      expect(input.variables.input.title).toBe('Adapter test')
      expect(input.variables.input.body).toContain('Created by [Build Agent]')
      expect(input.variables.input.body).toContain('<!-- realmroot-agent:')
      return Response.json({ data: { createIssue: { issue: { id: 'issue-1', url: 'https://github.test/2' } } } })
    })
    const body = {
      query: `mutation IssueCreate($input: CreateIssueInput!) {
        createIssue(input: $input) { issue { id url } }
      }`,
      variables: { input: { repositoryId: 'repository-1', title: 'Adapter test', body: 'Original' } },
    }
    const response = await testApp({ provider }).request('/github/graphql', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    })
    expect(response.status).toBe(200)
    await expect(response.json()).resolves.toEqual({
      data: { createIssue: { issue: { id: 'issue-1', url: 'https://github.test/2' } } },
    })
  })

  it('[spec: github-adapter/github-reserved-attribution] rejects forged attribution before GitHub', async () => {
    const provider = fakeProvider()
    const response = await testApp({ provider }).request('/github/repos/realmroot/example/issues', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ title: 'Forged', body: '<!-- realmroot-agent: fake -->' }),
    })
    expect(response.status).toBe(400)
    expect(provider.installationToken).not.toHaveBeenCalled()
    expect(provider.request).not.toHaveBeenCalled()

    const graphqlProvider = fakeProvider()
    const graphqlResponse = await testApp({ provider: graphqlProvider }).request('/github/graphql', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        query: 'mutation IssueCreate($input: CreateIssueInput!) { createIssue(input: $input) { issue { id } } }',
        variables: { input: { repositoryId: 'repository-1', title: 'Forged', body: '<!-- realmroot-agent: fake -->' } },
      }),
    })
    expect(graphqlResponse.status).toBe(400)
    expect(graphqlProvider.installationToken).not.toHaveBeenCalled()
    expect(graphqlProvider.request).not.toHaveBeenCalled()
  })

  it('[spec: github-adapter/github-provider-revocation] delegates signed revocation to the GitHub connection', async () => {
    const connections = fakeConnections()
    const revoke = vi.fn(async () => {})
    connections.revoke = revoke
    const response = await testApp({
      connections,
      revocationRequestVerifier: vi.fn(async () => ({
        sub: 'org_1',
        jti: 'revocation-1',
        exp: 1_800_000_060,
        connection_id: 'connection-1',
        resource_authorization_id: 'authorization-1',
        broker_reference: 'broker-1',
      })),
    }).request('/github/account-connection-revocations', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ request: 'signed-revocation' }),
    })
    expect(response.status).toBe(204)
    expect(revoke).toHaveBeenCalledWith({
      brokerReference: 'broker-1',
      ownerSubject: 'org_1',
      jti: 'revocation-1',
      expiresAt: 1_800_000_060_000,
    })
  })

  it('[spec: github-adapter/github-installation-lifecycle] exposes the signed lifecycle webhook before the proxy', async () => {
    const webhookSecret = 'github-webhook-secret'
    const body = JSON.stringify({ action: 'created', installation: { id: 42 } })
    const response = await testApp(
      { connectionEvents: { send: vi.fn(async () => {}) } },
      { githubWebhookSecret: webhookSecret },
    ).request('/github/webhooks', {
      method: 'POST',
      headers: {
        'X-GitHub-Delivery': 'delivery-created',
        'X-GitHub-Event': 'installation',
        'X-Hub-Signature-256': `sha256=${createHmac('sha256', webhookSecret).update(body).digest('hex')}`,
      },
      body,
    })
    expect(response.status).toBe(204)
  })

  it('[spec: github-adapter/provider-isolation] forbids imports between Provider implementations', async () => {
    const providersRoot = join(dirname(fileURLToPath(import.meta.url)), '../src/providers')
    const providers = (await readdir(providersRoot, { withFileTypes: true })).filter((entry) => entry.isDirectory())
    for (const provider of providers) {
      const directory = join(providersRoot, provider.name)
      const files = (await readdir(directory)).filter((name) => name.endsWith('.ts'))
      for (const file of files) {
        const source = await readFile(join(directory, file), 'utf8')
        for (const other of providers.filter((candidate) => candidate.name !== provider.name)) {
          expect(source, `${provider.name}/${file} imports ${other.name}`).not.toMatch(
            new RegExp(`from ['"][^'"]*providers/${other.name}(?:/|['"])`),
          )
          expect(source, `${provider.name}/${file} imports ${other.name}`).not.toMatch(
            new RegExp(`from ['"]\\.\\./${other.name}(?:/|['"])`),
          )
        }
      }
    }
  })
})

function testApp(
  overrides: Partial<GitHubAdapterDependencies> = {},
  configOverrides: Partial<GitHubAdapterConfig> = {},
) {
  const dependencies: GitHubAdapterDependencies = {
    authenticator: { authenticate: vi.fn(async () => principal) },
    agentInfo: {
      resolve: vi.fn(async () => ({
        name: 'Build Agent',
        picture: 'https://id.test/a.png',
        identityUrl: 'https://id.test/agents/agt_1',
      })),
    },
    provider: fakeProvider(),
    connections: fakeConnections(),
    audit: vi.fn(async () => {}),
    ...overrides,
  }
  return createApp([createGitHubAdapter({ ...config, ...configOverrides }, dependencies)])
}

function fakeProvider(): GitHubProvider {
  return {
    appPermissions: vi.fn(
      async () => ({ contents: 'write', metadata: 'read', issues: 'write', pull_requests: 'write' }) as const,
    ),
    openApiDocument: vi.fn(async () =>
      Response.json({
        openapi: '3.0.3',
        info: { title: 'GitHub REST API', version: '1.1.4' },
        components: { schemas: { issue: { type: 'object' } } },
        paths: {
          '/installation/repositories': {
            get: { operationId: 'apps/list-repos-accessible-to-installation', responses: { 200: {} } },
          },
          '/repos/{owner}/{repo}/issues': {
            parameters: [{ name: 'owner', in: 'path' }],
            get: { operationId: 'issues/list-for-repo', responses: { 200: {} } },
            post: {
              operationId: 'issues/create',
              servers: [{ url: 'https://uploads.github.com' }],
              responses: { 201: {} },
            },
          },
          '/applications/{client_id}/token': {
            patch: { operationId: 'apps/reset-token', responses: { 200: {} } },
          },
        },
      }),
    ),
    installationToken: vi.fn(async () => 'installation-secret'),
    request: vi.fn(async () => new Response(null, { status: 204 })),
  }
}

function fakeConnections(): GitHubConnectionStore {
  return {
    create: vi.fn(async () => {}),
    findByProviderState: vi.fn(),
    rotateProviderState: vi.fn(async () => {}),
    complete: vi.fn(async () => {}),
    exchange: vi.fn(),
    activeInstallationsForOwner: vi.fn(async () => [
      {
        installationId: 42,
        accountLogin: 'realmroot',
        targetType: 'Organization',
        scopes: [
          'contents:read',
          'contents:write',
          'issues:read',
          'issues:write',
          'metadata:read',
          'pull_requests:read',
          'pull_requests:write',
        ],
        repositorySelection: 'all' as const,
        repositories: [],
      },
    ]),
    activeInstallationsForReference: vi.fn(async () => [
      {
        installationId: 42,
        accountLogin: 'realmroot',
        targetType: 'Organization',
        scopes: [
          'contents:read',
          'contents:write',
          'issues:read',
          'issues:write',
          'metadata:read',
          'pull_requests:read',
          'pull_requests:write',
        ],
        repositorySelection: 'all' as const,
        repositories: [],
      },
    ]),
    revoke: vi.fn(async () => {}),
    prepareLifecycleEvent: vi.fn(async () => ({ event: null, completed: true })),
    pendingLifecycleEvents: vi.fn(async () => []),
    completeLifecycleEvent: vi.fn(async () => {}),
  }
}

function intent(status: 'completed') {
  return {
    requestId: 'request-1',
    connectionId: 'connection-1',
    expectedExternalSubject: null,
    ownerSubject: 'org_1',
    realmrootState: 'state',
    callbackUri: 'https://id.example/callback',
    codeChallenge: 'challenge',
    scopesJson: '["metadata:read"]',
    expectedInstallationId: null,
    status,
    expiresAt: Date.now() + 60_000,
  }
}
