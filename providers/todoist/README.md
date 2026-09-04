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

Provider URLs are fixed in the Todoist provider definition. Set
`TODOIST_CREDENTIAL_ENCRYPTION_KEY` to a base64-encoded 32-byte key to enable
the adapter; there are no URL environment variables.

The authorization URL is wrapped in Todoist's login page with the complete
OAuth request as `success_page`. Todoist otherwise drops PKCE parameters when
an unauthenticated browser is redirected through login.

The adapter persists one dynamically registered public client and stores each
provider credential encrypted in D1. Todoist's current revocation endpoints
require confidential-client authentication, so disconnecting revokes the
adapter-side grant and deletes the local credential but cannot revoke the
upstream public-client grant.
