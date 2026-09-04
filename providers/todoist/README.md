# Todoist Adapter

The Todoist adapter exposes a deliberately small, read-only Resource Server at
`/todoist`. It uses Todoist's RFC 7591 dynamic client registration with a
public OAuth client and PKCE, so operators do not provision a Todoist client ID
or client secret.

## Published operations

- `GET /todoist/projects` maps to `GET /api/v1/projects`.
- `GET /todoist/tasks` maps to `GET /api/v1/tasks`.

Both operations require the Agent-facing `tasks:read` scope, which maps to
Todoist's `data:read` provider scope.

## Configuration

The provider URLs have production defaults. Set
`TODOIST_CREDENTIAL_ENCRYPTION_KEY` to a base64-encoded 32-byte key to enable
the adapter. Optional URL overrides are declared in `wrangler.jsonc` for local
or test environments.

The adapter persists one dynamically registered public client and stores each
provider credential encrypted in D1. Todoist's current revocation endpoints
require confidential-client authentication, so disconnecting revokes the
adapter-side grant and deletes the local credential but cannot revoke the
upstream public-client grant.
