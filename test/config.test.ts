import { describe, expect, it } from 'vitest'
import { loadConfig } from '../src/config.js'
import { loadGitHubConfig } from '../src/providers/github/config.js'
import { loadLinearConfig } from '../src/providers/linear/config.js'

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
      GITHUB_WEBHOOK_SECRET: 'github-webhook-secret-with-32-characters',
      REALMROOT_APPLICATION_CLIENT_ID: 'realmroot-client',
      REALMROOT_APPLICATION_CLIENT_SECRET: 'realmroot-secret',
      REALMROOT_GITHUB_RESOURCE_SERVER_ID: 'res_github',
      LINEAR_API_ORIGIN: 'https://api.linear.example/',
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
      githubWebhookSecret: 'github-webhook-secret-with-32-characters',
      realmrootApplicationClientId: 'realmroot-client',
      realmrootApplicationClientSecret: 'realmroot-secret',
      realmrootGitHubResourceServerId: 'res_github',
    })
    expect(loadLinearConfig(environment, config)).toMatchObject({
      linearApiOrigin: 'https://api.linear.example',
      applicationClientId: 'realmroot-client',
      applicationClientSecret: 'realmroot-secret',
    })
  })

  it('fails when required Realmroot bindings are missing', () => {
    expect(() => loadConfig({}, 'https://adapter.example/health')).toThrow()
  })

  it('rejects short webhook secrets and partial Realmroot Application configuration', () => {
    const base = {
      REALMROOT_ISSUER: 'https://local.realmroot.dev/api/auth',
      REALMROOT_JWKS_URL: 'https://local.realmroot.dev/api/auth/jwks',
    }
    const config = loadConfig(base, 'https://adapter.example/health')
    expect(() => loadGitHubConfig({ ...base, GITHUB_WEBHOOK_SECRET: 'short' }, config)).toThrow()
    expect(() => loadGitHubConfig({ ...base, REALMROOT_APPLICATION_CLIENT_ID: 'client' }, config)).toThrow()
  })
})
