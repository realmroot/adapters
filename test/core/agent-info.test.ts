import { describe, expect, it, vi } from 'vitest'
import { createAgentInfoResolver } from '../../src/core/agent-info.js'

const principal = {
  subject: 'org_1',
  issuer: 'https://id.example/api/auth',
  actor: { issuer: 'https://id.example/api/auth', subject: 'agt_1', profile: 'ai_agent' as const },
  scopes: new Set<string>(),
}

describe('Agent Profile resolution', () => {
  it('discovers the URI template once and verifies the returned identity', async () => {
    const fetcher = vi.fn(async (input: string | URL | Request) => {
      const url = String(input)
      if (url.endsWith('/.well-known/agent-configuration')) {
        return Response.json({ agent_profile_uri_template: 'https://id.example/api/public/agents/{subject}' })
      }
      return Response.json({
        type: 'agent',
        view: 'summary',
        issuer: principal.actor.issuer,
        subject: principal.actor.subject,
        name: 'Build Agent',
        picture: 'https://id.example/agent.png',
      })
    })
    const resolver = createAgentInfoResolver(fetcher as typeof fetch)

    await expect(resolver.resolve(principal)).resolves.toMatchObject({
      name: 'Build Agent',
      identityUrl: 'https://id.example/agents/agt_1',
    })
    await expect(resolver.resolve(principal)).resolves.toMatchObject({ name: 'Build Agent' })
    expect(fetcher.mock.calls.filter(([url]) => String(url).includes('agent-configuration'))).toHaveLength(1)
    expect(String(fetcher.mock.calls.at(-1)?.[0])).toBe('https://id.example/api/public/agents/agt_1')
  })

  it('rejects a mismatched Agent Profile identity and failed discovery', async () => {
    const mismatch = createAgentInfoResolver(
      vi.fn(async () =>
        Response.json({
          type: 'agent',
          view: 'summary',
          issuer: 'https://other.example',
          subject: 'agt_1',
          name: 'Agent',
          picture: 'https://id.example/a.png',
        }),
      ) as typeof fetch,
      'https://id.example/api/public/agents/{subject}',
    )
    await expect(mismatch.resolve(principal)).rejects.toThrow('did not match')

    const unavailable = createAgentInfoResolver(vi.fn(async () => new Response(null, { status: 503 })) as typeof fetch)
    await expect(unavailable.resolve(principal)).rejects.toThrow('discovery failed')
  })

  it('rejects invalid or cross-origin profile URI templates', async () => {
    await expect(
      createAgentInfoResolver(vi.fn() as typeof fetch, 'https://id.example/api/public/agents/static').resolve(
        principal,
      ),
    ).rejects.toThrow('template is invalid')
    await expect(
      createAgentInfoResolver(vi.fn() as typeof fetch, 'https://profiles.example/api/public/agents/{subject}').resolve(
        principal,
      ),
    ).rejects.toThrow('different origin')
  })
})
