CREATE TABLE linear_connection_intent (
  request_id TEXT PRIMARY KEY NOT NULL,
  connection_id TEXT NOT NULL,
  expected_external_subject TEXT,
  owner_subject TEXT NOT NULL,
  realmroot_state TEXT NOT NULL,
  callback_uri TEXT NOT NULL,
  code_challenge TEXT NOT NULL,
  scopes_json TEXT NOT NULL,
  provider_state_hash TEXT NOT NULL UNIQUE,
  linear_user_id TEXT,
  linear_user_name TEXT,
  status TEXT NOT NULL CHECK (status IN ('pending_user', 'pending_app', 'completed', 'exchanged')),
  authorization_code_hash TEXT UNIQUE,
  expires_at INTEGER NOT NULL,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE INDEX linear_connection_intent_expires_at_idx ON linear_connection_intent (expires_at);

CREATE TABLE linear_connection_binding (
  broker_reference TEXT PRIMARY KEY NOT NULL,
  owner_subject TEXT NOT NULL,
  linear_user_id TEXT NOT NULL,
  display_name TEXT NOT NULL,
  scopes_json TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('active', 'revoked')),
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE UNIQUE INDEX linear_connection_binding_active_owner_unique
ON linear_connection_binding (owner_subject)
WHERE status = 'active';

CREATE TABLE linear_connection_context (
  broker_reference TEXT NOT NULL,
  workspace_id TEXT NOT NULL,
  workspace_name TEXT NOT NULL,
  workspace_url_key TEXT NOT NULL,
  app_user_id TEXT NOT NULL,
  access_token_ciphertext TEXT NOT NULL,
  refresh_token_ciphertext TEXT NOT NULL,
  token_expires_at INTEGER NOT NULL,
  scopes_json TEXT NOT NULL,
  can_access_all_public_teams INTEGER NOT NULL DEFAULT 0,
  team_ids_json TEXT NOT NULL DEFAULT '[]',
  status TEXT NOT NULL CHECK (status IN ('active', 'revoked')),
  credential_version INTEGER NOT NULL DEFAULT 1,
  refresh_claim_until INTEGER,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  PRIMARY KEY (broker_reference, workspace_id),
  FOREIGN KEY (broker_reference) REFERENCES linear_connection_binding(broker_reference) ON DELETE CASCADE
);

CREATE UNIQUE INDEX linear_connection_context_active_workspace_unique
ON linear_connection_context (workspace_id)
WHERE status = 'active';

CREATE INDEX linear_connection_context_app_user_idx ON linear_connection_context (app_user_id);

CREATE TABLE linear_webhook_delivery (
  delivery_id TEXT PRIMARY KEY NOT NULL,
  expires_at INTEGER NOT NULL,
  created_at INTEGER NOT NULL
);

CREATE INDEX linear_webhook_delivery_expires_at_idx ON linear_webhook_delivery (expires_at);
