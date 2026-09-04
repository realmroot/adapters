CREATE TABLE managed_oauth_credential (
  provider_id TEXT NOT NULL,
  subject TEXT NOT NULL,
  display_name TEXT NOT NULL,
  access_token_ciphertext TEXT NOT NULL,
  refresh_token_ciphertext TEXT NOT NULL,
  token_expires_at INTEGER NOT NULL,
  provider_scope_json TEXT NOT NULL,
  credential_version INTEGER NOT NULL DEFAULT 1,
  updated_at INTEGER NOT NULL,
  PRIMARY KEY (provider_id, subject)
);
