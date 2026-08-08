ALTER TABLE github_connection_binding RENAME COLUMN connection_id TO broker_reference;
ALTER TABLE github_connection_context RENAME COLUMN connection_id TO broker_reference;

ALTER TABLE github_connection_binding ADD COLUMN owner_subject TEXT;

UPDATE github_connection_binding
SET owner_subject = (
  SELECT owner_subject
  FROM github_connection_intent
  WHERE github_connection_intent.connection_id = github_connection_binding.broker_reference
    AND github_connection_intent.github_user_id = github_connection_binding.github_user_id
  ORDER BY github_connection_intent.updated_at DESC
  LIMIT 1
);

DELETE FROM github_connection_binding
WHERE owner_subject IS NULL;

CREATE UNIQUE INDEX github_connection_binding_active_owner_unique
ON github_connection_binding (owner_subject)
WHERE status = 'active';

CREATE TABLE broker_request_replay (
  jti TEXT PRIMARY KEY NOT NULL,
  expires_at INTEGER NOT NULL,
  created_at INTEGER NOT NULL
);

CREATE INDEX broker_request_replay_expires_at_idx ON broker_request_replay (expires_at);
