# Context7 capability report

Status: Experimental

Context7 exposes a small read-only OpenAPI API and an OAuth 2 authorization
server with dynamic client registration. It does not expose the Realmroot
Resource Server contract directly, so the managed OpenAPI runtime supplies the
Agent-facing boundary.

## Published resources

| Agent operation | Upstream operation | Scope |
| --- | --- | --- |
| `GET /context7/libraries` | `GET /api/v2/libs/search` | `documentation:read` |
| `GET /context7/documentation` | `GET /api/v2/context` | `documentation:read` |

Both operations preserve Context7 query and response semantics. Unlisted
Context7 paths are not reachable through the Adapter.

## Authorization and identity

The Adapter dynamically registers a public OAuth client with Context7 and uses
authorization code with S256 PKCE. The registered client ID is public state in
D1. PKCE verifier state and controller access/refresh tokens are encrypted with
`CONTEXT7_CREDENTIAL_ENCRYPTION_KEY`.

Context7 sees the connected OAuth user. Realmroot and Adapter audit retain the
originating Agent. Context7 does not natively enforce or display that Agent, so
the declared identity level is `provider-delegated` with audit-only
attribution.

## Native readiness gaps

- no Realmroot Agent principal at the Context7 API boundary;
- no Agent-visible attribution in Context7;
- no DPoP-bound Context7 access token;
- no Realmroot protected-resource or service-description discovery.

The Adapter can retire when Context7 accepts Realmroot Agent identity and
proof-bound delegated authority directly.
