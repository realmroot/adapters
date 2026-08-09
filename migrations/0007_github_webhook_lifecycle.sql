ALTER TABLE github_connection_context ADD COLUMN status TEXT NOT NULL DEFAULT 'active'
  CHECK (status IN ('active', 'suspended'));
ALTER TABLE github_connection_context ADD COLUMN scopes_json TEXT NOT NULL DEFAULT '[]';
ALTER TABLE github_connection_context ADD COLUMN updated_at INTEGER;
ALTER TABLE github_connection_context ADD COLUMN repository_selection TEXT NOT NULL DEFAULT 'selected'
  CHECK (repository_selection IN ('all', 'selected'));
ALTER TABLE github_connection_binding ADD COLUMN event_revision INTEGER NOT NULL DEFAULT 0;
ALTER TABLE github_connection_binding ADD COLUMN lifecycle_claim TEXT;

CREATE TABLE github_webhook_delivery (
  delivery_id TEXT PRIMARY KEY NOT NULL,
  fingerprint TEXT NOT NULL,
  event_json TEXT NOT NULL,
  state TEXT NOT NULL CHECK (state IN ('pending', 'completed')),
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

-- Earlier schemas did not retain repository selection or selected repository membership.
-- Queue a generic revocation before removing that unknown authority; the Worker drains this outbox
-- before serving requests, so Realmroot and the adapter remain consistent before reconnection.
INSERT INTO github_webhook_delivery
  (delivery_id, fingerprint, event_json, state, created_at, updated_at)
SELECT
  'migration-0007-' || broker_reference,
  'migration-0007',
  json_object(
    'id', 'migration-0007-' || broker_reference,
    'type', 'revoked',
    'brokerReference', broker_reference,
    'occurredAt', strftime('%Y-%m-%dT%H:%M:%fZ', 'now'),
    'revision', event_revision + 1
  ),
  'pending',
  CAST(strftime('%s', 'now') AS INTEGER) * 1000,
  CAST(strftime('%s', 'now') AS INTEGER) * 1000
FROM github_connection_binding
WHERE status = 'active';

UPDATE github_connection_binding
SET status = 'revoked', event_revision = event_revision + 1
WHERE status = 'active';
DELETE FROM github_connection_context;

CREATE INDEX github_webhook_delivery_updated_at_idx ON github_webhook_delivery (updated_at);

CREATE TABLE github_connection_repository (
  installation_id INTEGER NOT NULL,
  repository_id INTEGER NOT NULL,
  full_name TEXT NOT NULL,
  updated_at INTEGER NOT NULL,
  PRIMARY KEY (installation_id, repository_id),
  FOREIGN KEY (installation_id) REFERENCES github_connection_context(installation_id) ON DELETE CASCADE
);

CREATE INDEX github_connection_repository_full_name_idx
ON github_connection_repository (installation_id, full_name);

CREATE TABLE github_installation_lifecycle_cursor (
  installation_id INTEGER PRIMARY KEY NOT NULL,
  provider_updated_at INTEGER NOT NULL,
  delivery_id TEXT NOT NULL,
  deletion_terminal INTEGER NOT NULL DEFAULT 0 CHECK (deletion_terminal IN (0, 1)),
  restrictive_suspension INTEGER NOT NULL DEFAULT 0 CHECK (restrictive_suspension IN (0, 1)),
  restrictive_selection INTEGER NOT NULL DEFAULT 0 CHECK (restrictive_selection IN (0, 1)),
  updated_at INTEGER NOT NULL
);

CREATE TABLE github_repository_lifecycle_cursor (
  installation_id INTEGER NOT NULL,
  repository_id INTEGER NOT NULL,
  provider_updated_at INTEGER NOT NULL,
  removed INTEGER NOT NULL CHECK (removed IN (0, 1)),
  updated_at INTEGER NOT NULL,
  PRIMARY KEY (installation_id, repository_id)
);
