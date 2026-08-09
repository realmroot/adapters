# Linear provider

Status: **experimental**

Identity level: **brokered native App actor**

## Actor semantics

Linear supports OAuth authorization with `actor=app` for Agents and service
accounts. The installed Realmroot App receives one stable identity in each
workspace. Every originating Realmroot Agent shares that Linear security
principal.

For supported create operations, the adapter can derive `createAsUser` and
`displayIconUrl` from the authenticated Realmroot Agent. Linear renders a
per-operation Agent attribution through the application without requiring a
content footer.
Those display fields are generated only by the trusted adapter and are never
accepted from Agent request input.

The display alias has no separate Linear user ID, profile, mention target, or
delegation identity. The capability manifest therefore classifies Linear as
brokered even though its per-operation attribution is provider-native.

## Initial Resource mapping

```text
Linear workspace
  team
    project
    issue
```

## Implemented vertical slice

- one user-facing Provider Connection, with a short user OAuth step followed by
  App installation using `actor=app`;
- multiple installed workspace contexts under that one Connection;
- encrypted access and rotating refresh credentials in provider-owned D1
  tables;
- transparent forwarding of the original Linear GraphQL API at
  `POST /linear/graphql`;
- operation-aware enforcement of Linear's official scopes;
- trusted `createAsUser` and `displayIconUrl` injection for `issueCreate` and
  `commentCreate` only;
- signed permission-change and OAuth-revocation webhook handling.

The temporary user token is used only to identify the stable Linear account
and is revoked before the App authorization begins. Agent Session execution is
outside this identity adapter: Realmroot does not wake or run Agents. A future
execution system may consume those Linear events independently.

## Scopes

Realmroot publishes Linear's official scope names directly: `read`, `write`,
`issues:create`, `comments:create`, `timeSchedule:write`, `app:assignable`,
`app:mentionable`, `customer:read`, `customer:write`, `initiative:read`, and
`initiative:write`. The adapter does not invent a second Linear permission
vocabulary.

The OpenAPI transport operation exposes each scope through a separate security
alternative. That lets an Agent client select the exact official scope before
it obtains its DPoP credential, while the adapter independently verifies the
selected GraphQL document against the token scope before forwarding it.

The App actor mode does not request the Linear admin scope.

## Current acceptance outcome

Production acceptance on **2026-08-08** completed the user OAuth and App
installation flow, a `read` viewer query, and an `issueCreate` mutation using
only `issues:create`. Linear rendered the resulting activity as **Mac Agent
(via Realmroot)** with the trusted Agent avatar and no content footer. Refresh,
revocation, and webhook lifecycle acceptance remain required before moving to
preview.

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

Linear currently offers the strongest provider-native display attribution of
the three initial providers. `🧪` records that useful preview behavior without
claiming that the external Realmroot Agent is the Linear security principal.
`🟨` denotes planned adapter ownership, not completed implementation.

| Profile capability | Status | Evidence and adapter responsibility |
| --- | --- | --- |
| `RESOURCE-HTTPS` | 🟨 | Linear has an HTTPS GraphQL API, but OAuth tokens are not documented as audience-bound to a selected workspace, team, or project Resource. |
| `RESOURCE-METADATA` | 🟨 | No RFC 9728 metadata is documented for Linear Resources. |
| `API-SERVICE-DESC` | 🟨 | Linear does not advertise a Resource-scoped contract with RFC 8631. |
| `API-OPENAPI` | 🟨 | Linear is GraphQL; the adapter publishes an OpenAPI transport contract for the original GraphQL endpoint. |
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
| `ACTOR-NATIVE` | 🧪 | `actor=app` creates one provider-native App user per workspace, but every Realmroot Agent shares it and the stable external Agent identifier is not the token principal. |
| `AGENT-DISPLAY` | 🧪 | Trusted adapter-supplied `createAsUser` and `displayIconUrl` render the originating Agent without a footer; the fields are operation display metadata, not identity proof. |
| `ACTOR-ASSERTION` | 🟨 | Linear does not document the RFC 7523 Agent assertion grant required by the profile. |
| `TOKEN-EXCHANGE` | 🟨 | Linear does not document RFC 8693 subject/actor token exchange. |
| `JWT-ACCESS-TOKEN` | 🟨 | Linear documents opaque Bearer access tokens rather than the required RFC 9068 actor and confirmation claims. |
| `DPOP` | 🟨 | Linear API calls use Bearer access tokens; the adapter requires DPoP on its Agent-facing boundary. |
| `JWK-THUMBPRINT` | 🟨 | The adapter owns the inbound `cnf.jkt` binding. |
| `RICH-AUTHORIZATION` | ➖ | The initial Linear mode does not use RFC 9396; workspace and team selection remain provider-specific. |
| `PUSHED-AUTHORIZATION` | ➖ | PAR is conditional on RFC 9396 use. |
| `AUTHORIZATION-CATALOG` | ➖ | The RFC 9396 catalog extension is not used; ordinary adapter Resource discovery still enumerates workspaces and teams. |
| `TOKEN-REVOCATION` | 🟨 | Linear accepts RFC 7009-shaped `token` and `token_type_hint` fields, but documents `400` for an already revoked token instead of RFC 7009's idempotent success response. |
| `LIFECYCLE-SIGNALS` | 🧪 | Agent webhooks and Agent Session events support native lifecycle flows, but the API is Developer Preview. |

## Native-readiness gaps and retirement

Linear provides provider-native App identity and per-operation Agent display,
but the adapter still translates Realmroot identity and authority into one
shared Linear OAuth App actor and provider credential. Linear does not directly
validate the external stable Agent principal and proof-bound Realmroot
authority at its API Resource boundary.

This adapter can be retired when Linear accepts that identity and authority
directly instead of recording the shared Realmroot App user as the security
principal.

Current retirement blockers are direct acceptance of the stable Realmroot Agent
principal, DPoP-bound authority, and every applicable `🟨` or preview `🧪`
capability.
