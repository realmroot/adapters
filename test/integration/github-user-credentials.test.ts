import { env } from 'cloudflare:test'
import { describe, expect, it } from 'vitest'
import { createCredentialCipher } from '../../src/core/credential-cipher.js'
import { D1GitHubUserCredentials } from '../../src/providers/github/credentials.js'

describe('GitHub delegated-user credential persistence', () => {
  it('[spec: github-adapter/github-cross-fork-pull-request] encrypts, rotates, and revokes the provider credential', async () => {
    const store = new D1GitHubUserCredentials(
      env.DB,
      createCredentialCipher('AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA'),
    )
    await store.upsert('70', {
      accessToken: 'user-token',
      refreshToken: 'refresh-token',
      expiresAt: 1_800_000_000_000,
      refreshTokenExpiresAt: 1_900_000_000_000,
    })

    const stored = await env.DB.prepare(
      'SELECT access_token_ciphertext AS accessToken, refresh_token_ciphertext AS refreshToken FROM github_user_credential WHERE subject = ?',
    )
      .bind('70')
      .first<{ accessToken: string; refreshToken: string }>()
    expect(stored?.accessToken).not.toContain('user-token')
    expect(stored?.refreshToken).not.toContain('refresh-token')

    const credential = await store.credential('70')
    expect(credential).toMatchObject({ accessToken: 'user-token', refreshToken: 'refresh-token', credentialVersion: 1 })
    await expect(
      store.replace(credential, {
        accessToken: 'fresh-user-token',
        refreshToken: 'fresh-refresh-token',
        expiresAt: 1_810_000_000_000,
        refreshTokenExpiresAt: 1_910_000_000_000,
      }),
    ).resolves.toBe(true)
    await expect(store.replace(credential, credential)).resolves.toBe(false)
    await expect(store.credential('70')).resolves.toMatchObject({
      accessToken: 'fresh-user-token',
      refreshToken: 'fresh-refresh-token',
      credentialVersion: 2,
    })

    await store.revoke('70')
    await expect(store.credential('70')).rejects.toThrow(
      'Reconnect the GitHub account before creating cross-account pull requests.',
    )
  })
})
