INSERT INTO managed_oauth_credential
  (provider_id, subject, display_name, access_token_ciphertext, refresh_token_ciphertext,
   token_expires_at, provider_scope_json, credential_version, updated_at)
SELECT 'context7', subject, display_name, access_token_ciphertext, refresh_token_ciphertext,
       token_expires_at, provider_scope_json, credential_version, updated_at
FROM context7_external_credential
WHERE true
ON CONFLICT(provider_id, subject) DO UPDATE SET
  display_name = excluded.display_name,
  access_token_ciphertext = excluded.access_token_ciphertext,
  refresh_token_ciphertext = excluded.refresh_token_ciphertext,
  token_expires_at = excluded.token_expires_at,
  provider_scope_json = excluded.provider_scope_json,
  credential_version = excluded.credential_version,
  updated_at = excluded.updated_at;

DROP TABLE context7_external_credential;
