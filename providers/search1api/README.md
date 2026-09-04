# Search1API Adapter

Status: Experimental

Search1API is a provider-delegated query Resource at `/search1api`. The
connected Search1API user is the upstream security principal; Realmroot and
Adapter audit preserve the originating Agent, which Search1API does not
natively display or enforce.

## Published resources

| Agent operation | Upstream operation | Scope |
| --- | --- | --- |
| `POST /search1api/searches` | `POST /search` | `search:read` |
| `POST /search1api/news-searches` | `POST /news` | `search:read` |
| `GET /search1api/usage` | `GET /usage` | `search:read` |

Only these allowlisted operations are forwarded. Search requests follow the
upstream retry and billing semantics; the Adapter does not retry them.

## Authorization and lifecycle

Search1API supports public RFC 7591 registration, authorization code with S256
PKCE, refresh tokens, and token revocation. The Adapter stores one public
client ID and encrypts each user's access and refresh credentials with
`SEARCH1API_CREDENTIAL_ENCRYPTION_KEY`. Provider endpoints are fixed in the
definition and require no environment configuration.

The Adapter can retire when Search1API accepts and audits the stable Realmroot
Agent with proof-bound delegated authority directly. Current gaps are native
Agent identity, provider-visible Agent attribution, and upstream DPoP.
