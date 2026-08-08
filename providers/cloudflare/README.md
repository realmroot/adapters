# Cloudflare provider

Status: **design**

Identity level: **native service principal**

## Actor semantics

Cloudflare account-owned API tokens are account service principals rather than
credentials tied to a human user. The initial design maps one authorized
Realmroot Agent to one dedicated account-owned token.

Cloudflare audit records expose token identifiers and names, allowing provider-
side correlation with the Agent service principal. This is native audit
identity, not a collaborator identity rendered on every Cloudflare resource.

## Initial Resource mapping

```text
Cloudflare account
  zone
  account-owned product resource
```

## Initial operations

- discover accounts and zones;
- resolve token permission groups;
- create and manage a narrow Agent service principal;
- read and update representative DNS resources;
- read and update one representative Workers resource;
- correlate representative writes with Cloudflare audit logs.

## Authorization considerations

Creating account-owned tokens requires an appropriately privileged Cloudflare
administrator. The connection flow must make that requirement explicit and
must not ask users to paste token secrets into Agent-visible tooling.

Each token policy is restricted to the approved permission groups and account
or zone Resources. Token rotation, disablement, expiration, deletion, and
resource-policy changes fail closed.

## Acceptance outcome

A representative operation appears in Cloudflare's own audit log with the
dedicated Agent token ID and token name and can be correlated to the immutable
Realmroot Agent and approved authority.

## Profile 0.1 capability report

Assessment date: **2026-08-07**

Assessment target: Cloudflare account-owned API tokens and self-managed OAuth
clients.

Retirement conformance class: **Federated Platform**

Evidence: [account-owned service principals](https://developers.cloudflare.com/fundamentals/api/get-started/account-owned-tokens/),
[OAuth client flows](https://developers.cloudflare.com/fundamentals/oauth/create-an-oauth-client/),
[OAuth and OIDC endpoints](https://developers.cloudflare.com/fundamentals/oauth/integrate-with-cloudflare/),
and [Audit Logs v2 actor fields](https://developers.cloudflare.com/api/resources/accounts/subresources/logs/subresources/audit/methods/list/).

Cloudflare's self-managed OAuth client surface was introduced in 2026. Its
documented standards support is credited below, while a dedicated account-owned
token remains the selected initial Agent service-principal mode. `🟨` denotes
planned adapter ownership, not completed implementation.

| Profile capability | Status | Evidence and adapter responsibility |
| --- | --- | --- |
| `RESOURCE-HTTPS` | 🟨 | The API is HTTPS, but current Cloudflare credentials are not issued with the selected account or zone as an exact token audience. |
| `RESOURCE-METADATA` | 🟨 | No RFC 9728 metadata is documented for account and zone API Resources. |
| `API-SERVICE-DESC` | 🟨 | Cloudflare does not advertise the selected account or zone contract with an RFC 8631 link. |
| `API-OPENAPI` | 🟨 | The adapter will expose a constrained operation and permission mapping for its supported slice. |
| `AS-METADATA` | 🧪 | Cloudflare publishes OpenID configuration and JWKS for its new OAuth service; RFC 8414 conformance still needs direct contract tests. |
| `OIDC-CONNECTION` | 🧪 | Cloudflare documents OpenID configuration and UserInfo endpoints, but the new integration surface is not yet verified by this project. |
| `OAUTH-CODE` | ✅ | Self-managed OAuth clients support Authorization Code for confidential clients. |
| `OAUTH-REFRESH` | 🟨 | The reviewed Cloudflare contract does not document the refresh-token grant required by Profile 0.1. |
| `OAUTH-PKCE` | ✅ | Public clients require PKCE with `S256`; confidential clients may also use it. |
| `OAUTH-RESOURCE` | 🟨 | Account selection and scopes are provider-specific; no RFC 8707 Resource indicator is documented. |
| `CLIENT-REGISTRATION` | ➖ | OAuth clients and account tokens are created through Cloudflare management surfaces, not selected RFC 7591 registration. |
| `CLIENT-MANAGEMENT` | ➖ | Dynamic registration is not selected. |
| `ACTOR-CHAIN` | 🟨 | The adapter correlates the Realmroot Agent with the Cloudflare token actor; Cloudflare does not receive the RFC 8693 actor chain. |
| `ACTOR-PROFILE` | 🟨 | The adapter validates `ai_agent`; Cloudflare does not consume it. |
| `ACTOR-NATIVE` | 🟨 | Account-owned tokens are native service principals with their own permissions, but the Agent identity is still established by an adapter-owned token mapping. |
| `AGENT-DISPLAY` | 🟨 | Token names make the mapped service principal visible in audit data, not as a first-class external Agent identity. |
| `ACTOR-ASSERTION` | 🟨 | Cloudflare does not document the RFC 7523 Agent assertion grant required by the profile. |
| `TOKEN-EXCHANGE` | 🟨 | Cloudflare does not document RFC 8693 subject/actor token exchange for API access. |
| `JWT-ACCESS-TOKEN` | 🟨 | The adapter cannot rely on the provider token exposing the profile's RFC 9068 actor and confirmation claims. |
| `DPOP` | 🟨 | Cloudflare API calls use Bearer credentials; the adapter will require DPoP on its Agent-facing boundary. |
| `JWK-THUMBPRINT` | 🟨 | The adapter owns the inbound `cnf.jkt` binding. |
| `RICH-AUTHORIZATION` | ➖ | The initial Cloudflare mode does not use RFC 9396; account, zone, scope, and token-policy selection remain provider-specific. |
| `PUSHED-AUTHORIZATION` | ➖ | PAR is conditional on RFC 9396 use. |
| `AUTHORIZATION-CATALOG` | ➖ | The RFC 9396 catalog extension is not used; ordinary adapter Resource discovery still enumerates accounts and zones. |
| `TOKEN-REVOCATION` | 🟨 | Dashboard revocation and token disablement provide lifecycle control; direct RFC 7009 behavior still needs conformance evidence. |
| `LIFECYCLE-SIGNALS` | 🟨 | The adapter must detect OAuth revocation and account-token policy, expiration, rotation, or deletion changes. |

## Native-readiness gaps and retirement

An account-owned token gives Cloudflare a native service principal, but the
platform does not yet consume the external stable Agent identity and its
proof-bound delegated authority directly. The adapter still provisions and
holds a Cloudflare credential on the Agent's behalf.

This adapter can be retired when Cloudflare can accept the stable Agent and
approved account or zone authority at its API boundary, issue or validate
short-lived proof-bound access, and preserve that Agent directly in Cloudflare
audit records without an adapter-owned token mapping.

Current retirement blockers include the adapter-owned token-to-Agent mapping,
proof-bound authority, and every applicable `🟨` or unverified `🧪` capability.
