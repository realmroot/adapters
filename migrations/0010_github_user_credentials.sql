CREATE TABLE github_user_credential (
  subject TEXT PRIMARY KEY NOT NULL,
  access_token_ciphertext TEXT NOT NULL,
  refresh_token_ciphertext TEXT,
  access_token_expires_at INTEGER,
  refresh_token_expires_at INTEGER,
  credential_version INTEGER NOT NULL DEFAULT 1,
  updated_at INTEGER NOT NULL
);
