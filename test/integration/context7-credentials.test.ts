import { env } from 'cloudflare:test'
import { describe, expect, it } from 'vitest'
import { createCredentialCipher } from '../../src/core/credential-cipher.js'
import { D1DynamicOAuthRegistrationStore } from '../../src/core/dynamic-oauth-client.js'
import { D1Context7Credentials } from '../../src/providers/context7/oauth.js'

describe('Context7 D1 state', () => {
  it('[spec: context7-adapter/context7-provider-oauth] persists one dynamic client and encrypts provider credentials', async () => {
    const registrations = new D1DynamicOAuthRegistrationStore(env.DB)
    await expect(registrations.saveClientId('context7', 'client-first')).resolves.toBe('client-first')
    await expect(registrations.saveClientId('context7', 'client-racing')).resolves.toBe('client-first')

    const credentials = new D1Context7Credentials(
      env.DB,
      createCredentialCipher('AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA'),
    )
    await credentials.upsert(
      { subject: 'context7-user', displayName: 'Context User' },
      {
        accessToken: 'plain-access-token',
        refreshToken: 'plain-refresh-token',
        expiresAt: 10_000,
        scopes: ['openid', 'offline_access'],
      },
    )
    const row = await env.DB.prepare(
      `SELECT access_token_ciphertext AS accessToken, refresh_token_ciphertext AS refreshToken
       FROM context7_external_credential WHERE subject = ?`,
    )
      .bind('context7-user')
      .first<{ accessToken: string; refreshToken: string }>()
    expect(row?.accessToken).not.toContain('plain-access-token')
    expect(row?.refreshToken).not.toContain('plain-refresh-token')
    await expect(credentials.credential('context7-user')).resolves.toMatchObject({
      accessToken: 'plain-access-token',
      refreshToken: 'plain-refresh-token',
      displayName: 'Context User',
    })

    const sealedVerifier = await credentials.sealVerifier('pkce-verifier')
    expect(sealedVerifier).not.toContain('pkce-verifier')
    await expect(credentials.openVerifier(sealedVerifier)).resolves.toBe('pkce-verifier')
  })
})
