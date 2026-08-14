import type { CredentialCipher } from '../../core/credential-cipher.js'
import { forbidden } from '../../core/problem.js'
import type { GitHubUserCredential, GitHubUserToken } from './types.js'

export interface GitHubUserCredentialStore {
  upsert(subject: string, token: GitHubUserToken): Promise<void>
  credential(subject: string): Promise<GitHubUserCredential>
  replace(credential: GitHubUserCredential, token: GitHubUserToken): Promise<boolean>
  revoke(subject: string): Promise<void>
}

export class D1GitHubUserCredentials implements GitHubUserCredentialStore {
  constructor(
    private readonly db: D1Database,
    private readonly cipher: CredentialCipher,
  ) {}

  async upsert(subject: string, token: GitHubUserToken) {
    const context = credentialContext(subject)
    const [accessToken, refreshToken] = await Promise.all([
      this.cipher.seal(token.accessToken, `${context}:access`),
      token.refreshToken ? this.cipher.seal(token.refreshToken, `${context}:refresh`) : null,
    ])
    await this.db
      .prepare(
        `INSERT INTO github_user_credential
          (subject, access_token_ciphertext, refresh_token_ciphertext, access_token_expires_at,
           refresh_token_expires_at, credential_version, updated_at)
         VALUES (?, ?, ?, ?, ?, 1, ?)
         ON CONFLICT(subject) DO UPDATE SET
           access_token_ciphertext = excluded.access_token_ciphertext,
           refresh_token_ciphertext = excluded.refresh_token_ciphertext,
           access_token_expires_at = excluded.access_token_expires_at,
           refresh_token_expires_at = excluded.refresh_token_expires_at,
           credential_version = github_user_credential.credential_version + 1,
           updated_at = excluded.updated_at`,
      )
      .bind(subject, accessToken, refreshToken, token.expiresAt, token.refreshTokenExpiresAt, Date.now())
      .run()
  }

  async credential(subject: string): Promise<GitHubUserCredential> {
    const row = await this.db
      .prepare(
        `SELECT subject, access_token_ciphertext AS accessToken,
                refresh_token_ciphertext AS refreshToken, access_token_expires_at AS expiresAt,
                refresh_token_expires_at AS refreshTokenExpiresAt,
                credential_version AS credentialVersion
         FROM github_user_credential WHERE subject = ?`,
      )
      .bind(subject)
      .first<{
        subject: string
        accessToken: string
        refreshToken: string | null
        expiresAt: number | null
        refreshTokenExpiresAt: number | null
        credentialVersion: number
      }>()
    if (!row) throw forbidden('Reconnect the GitHub account before creating cross-account pull requests.')
    const context = credentialContext(subject)
    const [accessToken, refreshToken] = await Promise.all([
      this.cipher.open(row.accessToken, `${context}:access`),
      row.refreshToken ? this.cipher.open(row.refreshToken, `${context}:refresh`) : null,
    ])
    return { ...row, accessToken, refreshToken }
  }

  async replace(credential: GitHubUserCredential, token: GitHubUserToken) {
    const context = credentialContext(credential.subject)
    const [accessToken, refreshToken] = await Promise.all([
      this.cipher.seal(token.accessToken, `${context}:access`),
      token.refreshToken ? this.cipher.seal(token.refreshToken, `${context}:refresh`) : null,
    ])
    const result = await this.db
      .prepare(
        `UPDATE github_user_credential SET access_token_ciphertext = ?, refresh_token_ciphertext = ?,
           access_token_expires_at = ?, refresh_token_expires_at = ?,
           credential_version = credential_version + 1, updated_at = ?
         WHERE subject = ? AND credential_version = ?`,
      )
      .bind(
        accessToken,
        refreshToken,
        token.expiresAt,
        token.refreshTokenExpiresAt,
        Date.now(),
        credential.subject,
        credential.credentialVersion,
      )
      .run()
    return result.meta.changes === 1
  }

  async revoke(subject: string) {
    await this.db.prepare('DELETE FROM github_user_credential WHERE subject = ?').bind(subject).run()
  }
}

function credentialContext(subject: string) {
  return `github:${subject}:delegated-user`
}
