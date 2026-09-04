import { env } from 'cloudflare:test'
import { describe, expect, it } from 'vitest'
import { createCredentialCipher } from '../../src/core/credential-cipher.js'
import { D1ManagedOAuthCredentials } from '../../src/core/managed-oauth.js'

describe('Managed OAuth D1 credentials', () => {
  it('[spec: todoist-adapter/todoist-provider-oauth] isolates providers and encrypts reusable credentials', async () => {
    const credentials = new D1ManagedOAuthCredentials(
      'todoist',
      'Todoist',
      env.DB,
      createCredentialCipher('AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA'),
    )
    await credentials.upsert(
      { subject: 'todoist-user', displayName: 'Todo User' },
      {
        accessToken: 'plain-access-token',
        refreshToken: 'plain-refresh-token',
        expiresAt: 10_000,
        scopes: ['data:read'],
      },
    )
    const row = await env.DB.prepare(
      `SELECT provider_id AS providerId, access_token_ciphertext AS accessToken,
              refresh_token_ciphertext AS refreshToken
       FROM managed_oauth_credential WHERE provider_id = ? AND subject = ?`,
    )
      .bind('todoist', 'todoist-user')
      .first<{ providerId: string; accessToken: string; refreshToken: string }>()
    expect(row?.providerId).toBe('todoist')
    expect(row?.accessToken).not.toContain('plain-access-token')
    expect(row?.refreshToken).not.toContain('plain-refresh-token')
    await expect(credentials.credential('todoist-user')).resolves.toMatchObject({
      accessToken: 'plain-access-token',
      refreshToken: 'plain-refresh-token',
      displayName: 'Todo User',
      providerScopes: ['data:read'],
    })
  })
})
