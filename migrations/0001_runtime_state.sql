CREATE TABLE dpop_replay (
  proof_hash TEXT PRIMARY KEY NOT NULL,
  key_thumbprint TEXT NOT NULL,
  expires_at INTEGER NOT NULL,
  created_at INTEGER NOT NULL
);

CREATE INDEX dpop_replay_expires_at_idx ON dpop_replay (expires_at);

CREATE TABLE idempotency_response (
  namespace TEXT NOT NULL,
  idempotency_key TEXT NOT NULL,
  fingerprint TEXT NOT NULL,
  state TEXT NOT NULL CHECK (state IN ('pending', 'completed')),
  status INTEGER,
  headers_json TEXT,
  body TEXT,
  expires_at INTEGER NOT NULL,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  PRIMARY KEY (namespace, idempotency_key)
);

CREATE INDEX idempotency_response_expires_at_idx ON idempotency_response (expires_at);

CREATE TABLE adapter_audit_event (
  request_id TEXT PRIMARY KEY NOT NULL,
  event_json TEXT NOT NULL,
  occurred_at TEXT NOT NULL
);

CREATE INDEX adapter_audit_event_occurred_at_idx ON adapter_audit_event (occurred_at);
