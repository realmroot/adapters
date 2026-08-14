CREATE TABLE github_user_credential (
  subject TEXT PRIMARY KEY NOT NULL,
  access_token_ciphertext TEXT NOT NULL,
  refresh_token_ciphertext TEXT,
  access_token_expires_at INTEGER,
  refresh_token_expires_at INTEGER,
  credential_version INTEGER NOT NULL DEFAULT 1,
  updated_at INTEGER NOT NULL
);

UPDATE external_oauth_refresh
SET revoked_at = CAST(unixepoch('subsecond') * 1000 AS INTEGER),
    updated_at = CAST(unixepoch('subsecond') * 1000 AS INTEGER)
WHERE provider_id = 'github' AND revoked_at IS NULL;

UPDATE github_connection_binding
SET status = 'revoked', updated_at = CAST(unixepoch('subsecond') * 1000 AS INTEGER)
WHERE status = 'active';

DELETE FROM github_connection_context
WHERE broker_reference IN (
  SELECT broker_reference FROM github_connection_binding WHERE status = 'revoked'
);
