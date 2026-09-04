# Fast.io Adapter

Status: Experimental

Fast.io is a provider-delegated, read-only workspace Resource at `/fastio`.
The connected Fast.io user remains the upstream principal while Realmroot and
Adapter audit retain the originating Agent.

## Published resources

| Agent operation | Upstream operation | Scope |
| --- | --- | --- |
| `GET /fastio/workspaces` | `GET /current/workspaces/all/` | `workspace:read` |
| `GET /fastio/profile-availability` | `GET /current/user/available_profiles/` | `workspace:read` |

Unlisted Fast.io operations are not reachable. Calls are read-only and follow
Fast.io's native retry behavior; the Adapter adds no retries.

## Authorization and lifecycle

Fast.io supports public RFC 7591 registration, authorization code with S256
PKCE, refresh tokens, and RFC 7009 token revocation. The definition requests
the `all_workspaces` provider scope. The Adapter stores the public client ID
and encrypts user credentials with `FASTIO_CREDENTIAL_ENCRYPTION_KEY`.
Provider API and OAuth endpoints are fixed in code.

The Adapter can retire when Fast.io accepts and audits the stable Realmroot
Agent with proof-bound delegated authority directly. Current gaps are native
Agent identity, provider-visible Agent attribution, and upstream DPoP.
