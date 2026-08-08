CREATE TABLE github_connection_intent (
  request_id TEXT PRIMARY KEY NOT NULL,
  connection_id TEXT NOT NULL,
  expected_external_subject TEXT,
  owner_subject TEXT NOT NULL,
  realmroot_state TEXT NOT NULL,
  callback_uri TEXT NOT NULL,
  code_challenge TEXT NOT NULL,
  scopes_json TEXT NOT NULL,
  provider_state_hash TEXT NOT NULL UNIQUE,
  expected_installation_id INTEGER,
  github_user_id INTEGER,
  github_login TEXT,
  authorization_code_hash TEXT UNIQUE,
  status TEXT NOT NULL CHECK (status IN ('pending_oauth', 'awaiting_install', 'completed', 'exchanged')),
  expires_at INTEGER NOT NULL,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE INDEX github_connection_intent_expires_at_idx ON github_connection_intent (expires_at);

CREATE TABLE github_connection_binding (
  connection_id TEXT PRIMARY KEY NOT NULL,
  github_user_id INTEGER NOT NULL,
  github_login TEXT NOT NULL,
  display_name TEXT NOT NULL,
  scopes_json TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('active', 'revoked')),
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE TABLE github_connection_context (
  connection_id TEXT NOT NULL,
  installation_id INTEGER NOT NULL,
  account_login TEXT NOT NULL,
  target_type TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  PRIMARY KEY (connection_id, installation_id),
  FOREIGN KEY (connection_id) REFERENCES github_connection_binding(connection_id) ON DELETE CASCADE
);

CREATE INDEX github_connection_context_installation_id_idx ON github_connection_context (installation_id);
