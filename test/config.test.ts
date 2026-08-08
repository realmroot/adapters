import { describe, expect, it } from 'vitest'
import { loadConfig } from '../src/config.js'
import { loadGitHubConfig } from '../src/providers/github/config.js'

describe('adapter Worker configuration', () => {
  it('reads bindings and derives the canonical adapter origin from the request', () => {
    const environment = {
      REALMROOT_ISSUER: 'https://local.realmroot.dev/api/auth/',
      REALMROOT_JWKS_URL: 'https://local.realmroot.dev/api/auth/jwks',
      REALMROOT_AGENT_PROFILE_URI_TEMPLATE: 'https://local.realmroot.dev/api/public/agents/{subject}',
      GITHUB_API_ORIGIN: 'https://api.github.com/',
      GITHUB_UPLOADS_ORIGIN: 'https://uploads.github.com/',
      GITHUB_APP_ID: '123',
      GITHUB_PRIVATE_KEY: 'private-key',
    }
    const config = loadConfig(environment, 'https://adapter.example/health')

    expect(config).toEqual({
      origin: 'https://adapter.example',
      realmrootIssuer: 'https://local.realmroot.dev/api/auth',
      realmrootJwksUrl: 'https://local.realmroot.dev/api/auth/jwks',
      realmrootAgentProfileUriTemplate: 'https://local.realmroot.dev/api/public/agents/{subject}',
    })
    expect(loadGitHubConfig(environment, config)).toMatchObject({
      githubApiOrigin: 'https://api.github.com',
      githubUploadsOrigin: 'https://uploads.github.com',
      githubAppId: '123',
      githubPrivateKey: 'private-key',
    })
  })

  it('fails when required Realmroot bindings are missing', () => {
    expect(() => loadConfig({}, 'https://adapter.example/health')).toThrow()
  })
})
