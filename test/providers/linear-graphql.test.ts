import { describe, expect, it, vi } from 'vitest'
import type { AgentPrincipal } from '../../src/core/realmroot-auth.js'
import { prepareLinearGraphqlRequest } from '../../src/providers/linear/graphql.js'

describe('Linear GraphQL boundary', () => {
  it('[spec: linear-adapter/linear-transparent-graphql] preserves an authorized query body', async () => {
    const raw = JSON.stringify({ query: 'query Me { viewer { id name } }' })
    await expect(
      prepareLinearGraphqlRequest({ request: request(raw), principal: principal(['read']), agentInfo: agentInfo() }),
    ).resolves.toBe(raw)
  })

  it('[spec: linear-adapter/linear-operation-scope] enforces official scopes per selected operation', async () => {
    await expect(
      prepareLinearGraphqlRequest({
        request: request(JSON.stringify({ query: 'query Customers { customers { nodes { id } } }' })),
        principal: principal(['read']),
        agentInfo: agentInfo(),
      }),
    ).rejects.toThrow('customer:read')

    await expect(
      prepareLinearGraphqlRequest({
        request: request(
          JSON.stringify({
            query: 'mutation Create($input: IssueCreateInput!) { issueCreate(input: $input) { success } }',
            variables: { input: { title: 'Issue', teamId: 'team-1' } },
          }),
        ),
        principal: principal(['issues:create']),
        agentInfo: agentInfo(),
      }),
    ).resolves.toContain('createAsUser')
  })

  it('[spec: linear-adapter/linear-agent-display] injects verified display fields and rejects caller identity', async () => {
    const prepared = await prepareLinearGraphqlRequest({
      request: request(
        JSON.stringify({
          query: 'mutation Create($input: CommentCreateInput!) { commentCreate(input: $input) { success } }',
          variables: { input: { body: 'Hello', issueId: 'issue-1' } },
        }),
      ),
      principal: principal(['comments:create']),
      agentInfo: agentInfo(),
    })
    expect(JSON.parse(prepared)).toMatchObject({
      variables: {
        input: {
          body: 'Hello',
          createAsUser: 'Mac Agent',
          displayIconUrl: 'https://id.example/agents/mac.png',
        },
      },
    })

    await expect(
      prepareLinearGraphqlRequest({
        request: request(
          JSON.stringify({
            query: 'mutation Create($input: IssueCreateInput!) { issueCreate(input: $input) { success } }',
            variables: { input: { title: 'Issue', createAsUser: 'Spoofed Agent' } },
          }),
        ),
        principal: principal(['write']),
        agentInfo: agentInfo(),
      }),
    ).rejects.toThrow('reserved')
  })

  it('rejects ambiguous operations, subscriptions, invalid JSON, and oversized bodies', async () => {
    await expect(
      prepareLinearGraphqlRequest({
        request: request(JSON.stringify({ query: 'query A { viewer { id } } query B { viewer { id } }' })),
        principal: principal(['read']),
        agentInfo: agentInfo(),
      }),
    ).rejects.toThrow('Select exactly one')
    await expect(
      prepareLinearGraphqlRequest({
        request: request(JSON.stringify({ query: 'subscription Events { issue { id } }' })),
        principal: principal(['read']),
        agentInfo: agentInfo(),
      }),
    ).rejects.toThrow('subscriptions are not supported')
    await expect(
      prepareLinearGraphqlRequest({ request: request('{'), principal: principal(['read']), agentInfo: agentInfo() }),
    ).rejects.toThrow('invalid')
    await expect(
      prepareLinearGraphqlRequest({
        request: new Request('https://adapter.example/linear/graphql', {
          method: 'POST',
          headers: { 'content-type': 'application/json', 'content-length': String(513 * 1024) },
          body: '{}',
        }),
        principal: principal(['read']),
        agentInfo: agentInfo(),
      }),
    ).rejects.toThrow('may not exceed')
  })
})

function request(body: string) {
  return new Request('https://adapter.example/linear/graphql', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body,
  })
}

function principal(scopes: string[]): AgentPrincipal {
  return {
    subject: 'owner-1',
    issuer: 'https://id.example/api/auth',
    actor: { issuer: 'https://id.example/api/auth', subject: 'agent-1', profile: 'ai_agent' },
    scopes: new Set(scopes),
    connectionId: 'connection-1',
    authorizationDetails: [{ type: 'linear_workspace', workspace_id: 'workspace-1' }],
  }
}

function agentInfo() {
  return {
    resolve: vi.fn(async () => ({
      name: 'Mac Agent',
      picture: 'https://id.example/agents/mac.png',
      identityUrl: 'https://id.example/agents/agent-1',
    })),
  }
}
