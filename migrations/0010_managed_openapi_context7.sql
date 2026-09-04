CREATE TABLE managed_oauth_client (
  provider_id TEXT PRIMARY KEY NOT NULL,
  client_id TEXT NOT NULL,
  created_at INTEGER NOT NULL
);

CREATE TABLE context7_external_credential (
  subject TEXT PRIMARY KEY NOT NULL,
  display_name TEXT NOT NULL,
  access_token_ciphertext TEXT NOT NULL,
  refresh_token_ciphertext TEXT NOT NULL,
  token_expires_at INTEGER NOT NULL,
  provider_scope_json TEXT NOT NULL,
  credential_version INTEGER NOT NULL DEFAULT 1,
  updated_at INTEGER NOT NULL
);
