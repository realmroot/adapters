# Linear provider

Status: **design**

Identity level: **native Agent**

## Actor semantics

Linear supports OAuth authorization with `actor=app` for Agents and service
accounts. The installed App receives a workspace identity and can participate
in native Agent workflows.

For supported create operations, the adapter can derive `createAsUser` and
`displayIconUrl` from the authenticated Realmroot Agent. Linear renders the
Agent identity through the application without requiring a content footer.
Those display fields are generated only by the trusted adapter and are never
accepted from Agent request input.

The capability manifest will distinguish the stable Linear App actor from the
per-operation Agent display identity instead of claiming they are the same
provider security principal.

## Initial Resource mapping

```text
Linear workspace
  team
    project
    issue
```

## Initial operations

- install the App with `actor=app`;
- discover the workspace and permitted teams;
- create issues and comments with trusted Agent display identity;
- receive mention, delegation, permission-change, and revocation webhooks;
- participate in Agent Sessions and publish Agent activity;
- read representative project and document context.

## Initial scopes

- minimum read access required for discovery;
- targeted issue and comment creation scopes;
- `app:assignable` and `app:mentionable` only for the native Agent journey;
- additional Resource scopes only with an explicit operation requiring them.

The App actor mode does not request the Linear admin scope.

## Acceptance outcome

A Realmroot Agent can be installed into an isolated Linear workspace, appear
with trusted name and avatar, be mentioned or delegated an issue, create a
comment, and complete a native Agent Session. Linear and Realmroot audit data
remain correlated throughout the journey.

## Stability note

Linear's Agent APIs are currently documented as Developer Preview. The adapter
will remain experimental until the upstream contract is stable enough for a
supported compatibility promise.

## Profile 0.1 capability report

Assessment date: **2026-08-07**

Assessment target: Linear OAuth with `actor=app` and the Linear for Agents
Developer Preview.

Retirement conformance class: **Federated Platform**

Evidence: [OAuth 2.0 authentication](https://linear.app/developers/oauth-2-0-authentication),
[OAuth actor authorization](https://linear.app/developers/oauth-actor-authorization),
and [Linear for Agents](https://linear.app/developers/agents).

Linear currently offers the strongest product-native Agent experience of the
three initial providers. `🧪` records that useful preview behavior without
claiming that the external Realmroot Agent is already the Linear security
principal. `🟨` denotes planned adapter ownership, not completed implementation.

| Profile capability | Status | Evidence and adapter responsibility |
| --- | --- | --- |
| `RESOURCE-HTTPS` | 🟨 | Linear has an HTTPS GraphQL API, but OAuth tokens are not documented as audience-bound to a selected workspace, team, or project Resource. |
| `RESOURCE-METADATA` | 🟨 | No RFC 9728 metadata is documented for Linear Resources. |
| `API-SERVICE-DESC` | 🟨 | Linear does not advertise a Resource-scoped contract with RFC 8631. |
| `API-OPENAPI` | 🟨 | Linear is GraphQL; the adapter will publish an OpenAPI contract for its constrained Agent-facing operation slice. |
| `AS-METADATA` | 🟨 | Linear documents OAuth endpoints directly; required RFC 8414 metadata is not part of the public contract reviewed. |
| `OIDC-CONNECTION` | 🟨 | Linear exposes provider-specific OAuth identity through its API rather than the complete OIDC connection contract. |
| `OAUTH-CODE` | ✅ | Linear supports the Authorization Code grant. |
| `OAUTH-REFRESH` | ✅ | Linear returns rotating refresh tokens and documents the refresh-token grant. |
| `OAUTH-PKCE` | ✅ | Linear documents PKCE and the `code_verifier` token exchange. |
| `OAUTH-RESOURCE` | 🟨 | Workspace access and team scopes are provider-specific rather than RFC 8707 Resource indicators. |
| `CLIENT-REGISTRATION` | ➖ | The Linear OAuth App is preregistered. |
| `CLIENT-MANAGEMENT` | ➖ | Dynamic client registration is not selected. |
| `ACTOR-CHAIN` | 🟨 | The adapter preserves Realmroot actor context, but Linear receives an App actor token. |
| `ACTOR-PROFILE` | 🟨 | The adapter validates `ai_agent`; Linear does not consume that profile. |
| `ACTOR-NATIVE` | 🧪 | `actor=app` and Agent APIs create a provider-native non-human experience, but the stable external Agent identifier is not the token principal. |
| `AGENT-DISPLAY` | 🧪 | Trusted adapter-supplied `createAsUser` and `displayIconUrl` render the originating Agent without a footer; the fields are operation display metadata, not identity proof. |
| `ACTOR-ASSERTION` | 🟨 | Linear does not document the RFC 7523 Agent assertion grant required by the profile. |
| `TOKEN-EXCHANGE` | 🟨 | Linear does not document RFC 8693 subject/actor token exchange. |
| `JWT-ACCESS-TOKEN` | 🟨 | Linear documents opaque Bearer access tokens rather than the required RFC 9068 actor and confirmation claims. |
| `DPOP` | 🟨 | Linear API calls use Bearer access tokens; the adapter will require DPoP on its Agent-facing boundary. |
| `JWK-THUMBPRINT` | 🟨 | The adapter owns the inbound `cnf.jkt` binding. |
| `RICH-AUTHORIZATION` | ➖ | The initial Linear mode does not use RFC 9396; workspace and team selection remain provider-specific. |
| `PUSHED-AUTHORIZATION` | ➖ | PAR is conditional on RFC 9396 use. |
| `AUTHORIZATION-CATALOG` | ➖ | The RFC 9396 catalog extension is not used; ordinary adapter Resource discovery still enumerates workspaces and teams. |
| `TOKEN-REVOCATION` | 🟨 | Linear accepts RFC 7009-shaped `token` and `token_type_hint` fields, but documents `400` for an already revoked token instead of RFC 7009's idempotent success response. |
| `LIFECYCLE-SIGNALS` | 🧪 | Agent webhooks and Agent Session events support native lifecycle flows, but the API is Developer Preview. |

## Native-readiness gaps and retirement

Linear provides the strongest initial product-native Agent experience, but the
adapter still translates Realmroot identity and authority into a Linear OAuth
App actor and provider credential. Linear does not yet directly validate the
external stable Agent principal and proof-bound Realmroot authority at its API
Resource boundary.

This adapter can be retired when Linear accepts that identity and authority
directly while retaining its native Agent member, delegation, session, display,
audit, and revocation experience.

Current retirement blockers are direct acceptance of the stable Realmroot Agent
principal, DPoP-bound authority, and every applicable `🟨` or preview `🧪`
capability.
