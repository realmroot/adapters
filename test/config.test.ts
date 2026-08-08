import { mkdtemp, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import { loadConfig } from '../src/config.js'

describe('adapter configuration', () => {
  it('discovers Realmroot canonical endpoints and reads the GitHub private key boundary', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'realmroot-adapter-'))
    const privateKeyPath = join(directory, 'github.pem')
    await writeFile(privateKeyPath, 'private-key')
    const fetcher = vi.fn(async () =>
      Response.json({
        issuer: 'https://local.realmroot.dev/api/auth',
        jwks_uri: 'https://local.realmroot.dev/api/auth/jwks',
        agentinfo_endpoint: 'https://local.realmroot.dev/api/auth/agentinfo',
      }),
    )
    const config = await loadConfig(
      {
        PORT: '5100',
        ORIGIN: 'http://127.0.0.1:5100/',
        REALMROOT_ORIGIN: 'http://127.0.0.1:4179/',
        GITHUB_APP_ID: '123',
        GITHUB_PRIVATE_KEY_PATH: privateKeyPath,
      },
      fetcher as typeof fetch,
    )

    expect(config).toMatchObject({
      port: 5100,
      origin: 'http://127.0.0.1:5100',
      realmrootIssuer: 'https://local.realmroot.dev/api/auth',
      githubAppId: '123',
      githubPrivateKey: 'private-key',
    })
    expect(fetcher).toHaveBeenCalledWith(
      'http://127.0.0.1:4179/api/auth/.well-known/openid-configuration',
      expect.anything(),
    )
  })

  it('fails when Realmroot discovery is unavailable', async () => {
    await expect(
      loadConfig({}, vi.fn(async () => new Response(null, { status: 503 })) as typeof fetch),
    ).rejects.toThrow('discovery failed with 503')
  })
})
