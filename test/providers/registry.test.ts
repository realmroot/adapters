import { describe, expect, it, vi } from 'vitest'
import {
  createProviderModules,
  type ProviderRegistration,
  providerDirectory,
  providerRegistry,
} from '../../src/providers/registry.js'
import type { ProviderRuntime } from '../../src/providers/runtime.js'

describe('shared provider registration', () => {
  it('includes a newly registered provider in both the directory and runtime without initializing it for display', async () => {
    const module = { id: 'new-provider', register: vi.fn() }
    const create = vi.fn(async () => [module])
    const registration: ProviderRegistration = {
      id: 'new-provider',
      name: 'New Provider',
      category: 'Knowledge',
      description: 'New provider description',
      capabilities: ['Search'],
      maturity: 'Experimental',
      color: '#ffffff',
      mark: 'NP',
      requiredSecrets: ['CONTEXT7_CREDENTIAL_ENCRYPTION_KEY'],
      create,
    }
    const env = {
      ADAPTER_OAUTH_SIGNING_PRIVATE_JWK: 'private-key',
      CONTEXT7_CREDENTIAL_ENCRYPTION_KEY: 'secret-value',
    } as Env
    const directory = providerDirectory(env, [registration])
    expect(directory).toEqual([
      {
        id: 'new-provider',
        name: 'New Provider',
        category: 'Knowledge',
        description: 'New provider description',
        capabilities: ['Search'],
        maturity: 'Experimental',
        color: '#ffffff',
        mark: 'NP',
        enabled: true,
      },
    ])
    expect(create).not.toHaveBeenCalled()
    expect(JSON.stringify(directory)).not.toContain('secret-value')
    expect(JSON.stringify(directory)).not.toContain('private-key')
    const runtime = { env } as ProviderRuntime
    expect(await createProviderModules(runtime, [registration])).toEqual([module])
    expect(create).toHaveBeenCalledWith(runtime)
    expect(providerDirectory({} as Env, [registration])[0]?.enabled).toBe(false)
    expect(
      providerDirectory({ CONTEXT7_CREDENTIAL_ENCRYPTION_KEY: 'secret-value' } as Env, [registration])[0]?.enabled,
    ).toBe(false)
  })

  it('publishes unique identities for all registered providers', () => {
    const ids = providerRegistry.map(({ id }) => id)
    expect(new Set(ids).size).toBe(ids.length)
    expect(providerDirectory({} as Env).map(({ id }) => id)).toEqual(ids)
  })
})
