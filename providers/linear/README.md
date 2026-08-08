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

## Native-readiness gaps and retirement

Linear provides the strongest initial product-native Agent experience, but the
adapter still translates Realmroot identity and authority into a Linear OAuth
App actor and provider credential. Linear does not yet directly validate the
external stable Agent principal and proof-bound Realmroot authority at its API
Resource boundary.

This adapter can be retired when Linear accepts that identity and authority
directly while retaining its native Agent member, delegation, session, display,
audit, and revocation experience.
