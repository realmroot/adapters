CREATE TABLE external_oauth_client (
  client_id TEXT PRIMARY KEY NOT NULL,
  provider_id TEXT NOT NULL,
  client_secret_hash TEXT NOT NULL,
  redirect_uris_json TEXT NOT NULL,
  jwks_uri TEXT NOT NULL,
  created_at INTEGER NOT NULL
);

CREATE INDEX external_oauth_client_provider_idx ON external_oauth_client (provider_id);

CREATE TABLE external_oauth_intent (
  id TEXT PRIMARY KEY NOT NULL,
  provider_id TEXT NOT NULL,
  client_id TEXT NOT NULL,
  redirect_uri TEXT NOT NULL,
  realmroot_state TEXT NOT NULL,
  scope_json TEXT NOT NULL,
  authorization_details_json TEXT NOT NULL,
  code_challenge TEXT NOT NULL,
  provider_state_hash TEXT NOT NULL UNIQUE,
  provider_stage TEXT NOT NULL,
  provider_data_json TEXT NOT NULL DEFAULT '{}',
  status TEXT NOT NULL CHECK (status IN ('pending', 'completed')),
  expires_at INTEGER NOT NULL,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  FOREIGN KEY (client_id) REFERENCES external_oauth_client(client_id) ON DELETE CASCADE
);

CREATE INDEX external_oauth_intent_expires_at_idx ON external_oauth_intent (expires_at);

CREATE TABLE external_oauth_code (
  code_hash TEXT PRIMARY KEY NOT NULL,
  provider_id TEXT NOT NULL,
  client_id TEXT NOT NULL,
  redirect_uri TEXT NOT NULL,
  subject TEXT NOT NULL,
  display_name TEXT NOT NULL,
  scope_json TEXT NOT NULL,
  authorization_details_json TEXT NOT NULL,
  code_challenge TEXT NOT NULL,
  expires_at INTEGER NOT NULL,
  created_at INTEGER NOT NULL,
  FOREIGN KEY (client_id) REFERENCES external_oauth_client(client_id) ON DELETE CASCADE
);

CREATE INDEX external_oauth_code_expires_at_idx ON external_oauth_code (expires_at);

CREATE TABLE external_oauth_refresh (
  token_hash TEXT PRIMARY KEY NOT NULL,
  provider_id TEXT NOT NULL,
  client_id TEXT NOT NULL,
  subject TEXT NOT NULL,
  display_name TEXT NOT NULL,
  scope_json TEXT NOT NULL,
  authorization_details_json TEXT NOT NULL,
  revoked_at INTEGER,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  FOREIGN KEY (client_id) REFERENCES external_oauth_client(client_id) ON DELETE CASCADE
);

CREATE INDEX external_oauth_refresh_subject_idx ON external_oauth_refresh (provider_id, subject);

CREATE TABLE external_oauth_access (
  jti TEXT PRIMARY KEY NOT NULL,
  provider_id TEXT NOT NULL,
  client_id TEXT NOT NULL,
  subject TEXT NOT NULL,
  revoked_at INTEGER,
  expires_at INTEGER NOT NULL,
  created_at INTEGER NOT NULL,
  FOREIGN KEY (client_id) REFERENCES external_oauth_client(client_id) ON DELETE CASCADE
);

CREATE INDEX external_oauth_access_expires_at_idx ON external_oauth_access (expires_at);

CREATE TABLE cloudflare_external_credential (
  subject TEXT PRIMARY KEY NOT NULL,
  display_name TEXT NOT NULL,
  access_token_ciphertext TEXT NOT NULL,
  refresh_token_ciphertext TEXT NOT NULL,
  token_expires_at INTEGER NOT NULL,
  scope_json TEXT NOT NULL,
  credential_version INTEGER NOT NULL DEFAULT 1,
  updated_at INTEGER NOT NULL
);
