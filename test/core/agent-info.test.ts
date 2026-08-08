import { describe, expect, it, vi } from 'vitest'
import { createAgentInfoResolver } from '../../src/core/agent-info.js'

const principal = {
  subject: 'org_1',
  issuer: 'https://id.example/api/auth',
  actor: { issuer: 'https://id.example/api/auth', subject: 'agt_1', profile: 'ai_agent' as const },
  scopes: new Set<string>(),
}

describe('AgentInfo resolution', () => {
  it('discovers the endpoint once and verifies the returned identity', async () => {
    const fetcher = vi.fn(async (input: string | URL | Request) => {
      const url = String(input)
      if (url.endsWith('/.well-known/openid-configuration')) {
        return Response.json({ agentinfo_endpoint: 'https://id.example/api/auth/agentinfo' })
      }
      return Response.json({
        iss: principal.actor.issuer,
        sub: principal.actor.subject,
        name: 'Build Agent',
        picture: 'https://id.example/agent.png',
      })
    })
    const resolver = createAgentInfoResolver(fetcher as typeof fetch)

    await expect(resolver.resolve(principal)).resolves.toMatchObject({ name: 'Build Agent' })
    await expect(resolver.resolve(principal)).resolves.toMatchObject({ name: 'Build Agent' })
    expect(fetcher.mock.calls.filter(([url]) => String(url).includes('openid-configuration'))).toHaveLength(1)
    expect(String(fetcher.mock.calls.at(-1)?.[0])).toContain('sub=agt_1')
  })

  it('rejects a mismatched AgentInfo identity and failed discovery', async () => {
    const mismatch = createAgentInfoResolver(
      vi.fn(async () =>
        Response.json({
          iss: 'https://other.example',
          sub: 'agt_1',
          name: 'Agent',
          picture: 'https://id.example/a.png',
        }),
      ) as typeof fetch,
      'https://id.example/agentinfo',
    )
    await expect(mismatch.resolve(principal)).rejects.toThrow('did not match')

    const unavailable = createAgentInfoResolver(vi.fn(async () => new Response(null, { status: 503 })) as typeof fetch)
    await expect(unavailable.resolve(principal)).rejects.toThrow('discovery failed')
  })
})
