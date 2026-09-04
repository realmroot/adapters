import { exportJWK, generateKeyPair } from 'jose'
import { describe, expect, it, vi } from 'vitest'
import { createApp } from '../../src/app.js'
import { createConfiguredManagedProvider } from '../../src/core/configured-managed-provider.js'
import { D1ExternalOAuthStore } from '../../src/core/external-oauth-store.js'
import { context7Definition } from '../../src/providers/context7/definition.js'
import { fastioDefinition } from '../../src/providers/fastio/definition.js'
import { search1ApiDefinition } from '../../src/providers/search1api/definition.js'
import { todoistDefinition } from '../../src/providers/todoist/definition.js'

const definitions = [context7Definition, todoistDefinition, search1ApiDefinition, fastioDefinition]

describe('configured managed providers', () => {
  it.each(definitions)('$name publishes exactly its configured operation allowlist', (definition) => {
    const document = definition.openapi({
      resource: `https://adapter.example/${definition.id}`,
      issuer: `https://adapter.example/oauth/${definition.id}`,
    }) as { paths: Record<string, Record<string, { operationId: string }>> }
    const published = Object.entries(document.paths)
      .flatMap(([path, item]) =>
        Object.entries(item).map(([method, operation]) => ({ method: method.toUpperCase(), path, ...operation })),
      )
      .map(({ method, path, operationId }) => ({ method, path, operationId }))

    expect(published).toEqual(
      definition.operations.map(({ method, path, operationId }) => ({ method, path, operationId })),
    )
    expect(definition.upstreamOrigin).toMatch(/^https:\/\//)
    expect(Object.values(definition.endpoints).every((value) => value.startsWith('https://'))).toBe(true)
  })

  it('decodes Search1API and Fast.io provider identities from their documented shapes', () => {
    expect(search1ApiDefinition.identity({ sub: 'search-user', email: 'search@example.com' })).toEqual({
      subject: 'search-user',
      displayName: 'search@example.com',
    })
    expect(
      fastioDefinition.identity({
        result: true,
        user: { id: '1234567890123456789', first_name: 'Fast', last_name: 'User' },
      }),
    ).toEqual({ subject: '1234567890123456789', displayName: 'Fast User' })
  })

  it('composes discovery, authorization, and resource modules from a definition', async () => {
    const { privateKey } = await generateKeyPair('ES256', { extractable: true })
    const db = {} as D1Database
    const modules = await createConfiguredManagedProvider({
      definition: search1ApiDefinition,
      origin: 'https://adapter.example',
      db,
      credentialEncryptionKey: 'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA',
      signingPrivateJwk: await exportJWK(privateKey),
      oauthStore: new D1ExternalOAuthStore(db),
      replayStore: { claim: vi.fn(async () => true) },
      audit: vi.fn(async () => {}),
    })
    const app = createApp(modules)

    await expect((await app.request('/search1api')).json()).resolves.toMatchObject({
      resource: 'https://adapter.example/search1api',
      serviceDescription: 'https://adapter.example/search1api/openapi.json',
    })
    await expect((await app.request('/providers/search1api/manifest')).json()).resolves.toMatchObject({
      provider: 'search1api',
      credentialModes: ['adapter-dynamic-public-oauth'],
    })
    await expect((await app.request('/.well-known/oauth-protected-resource/search1api')).json()).resolves.toMatchObject(
      {
        resource: 'https://adapter.example/search1api',
        authorization_servers: ['https://adapter.example/oauth/search1api'],
      },
    )
  })
})
