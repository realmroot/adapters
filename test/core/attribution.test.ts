import { describe, expect, it } from 'vitest'
import { attributedBody } from '../../src/core/attribution.js'

const principal = {
  subject: 'organization-1',
  issuer: 'https://id.realmroot.dev/api/auth',
  actor: { issuer: 'https://id.realmroot.dev/api/auth', subject: 'agt_123', profile: 'ai_agent' as const },
  scopes: new Set<string>(),
}

describe('Agent attribution', () => {
  it('adds visible and machine-readable identity without changing the original content', () => {
    const body = attributedBody(
      'Original body',
      principal,
      {
        name: 'Research [Agent]',
        picture: 'https://example.com/agent.png',
        identityUrl: 'https://id.example/agentinfo?sub=agt_123',
      },
      'request-1',
    )

    expect(body).toContain('Original body\n\n---')
    expect(body).toContain('Created by [Research \\[Agent\\]]')
    expect(body).toContain('issuer=https%3A%2F%2Fid.realmroot.dev%2Fapi%2Fauth')
    expect(body).toContain('subject=agt_123')
    expect(body).toContain('request=request-1')
  })

  it('rejects caller-supplied reserved attribution', () => {
    expect(() =>
      attributedBody(
        '<!-- realmroot-agent: forged -->',
        principal,
        { name: 'Agent', picture: 'https://example.com/a.png', identityUrl: 'https://example.com/agent' },
        'request-1',
      ),
    ).toThrow('reserved Realmroot attribution marker')
  })
})
