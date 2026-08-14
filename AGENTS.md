# Repository Instructions

## Architecture Boundary

Every Adapter is a standard external OAuth authorization server and protected
Resource from Realmroot's perspective.

- Realmroot owns Agent identity, controller approval, Agent grants, one logical
  Connector per provider, and the Connector's independent authentication and
  resource-authorization facets.
- The Adapter owns provider authorization, credentials, refresh, revocation,
  lifecycle state, scope mapping, operation publication, final DPoP-token
  issuance, and provider API execution.
- Provider-specific OAuth stages, authorization-detail fields, webhook payloads,
  credentials, permissions, and API routing must not enter Realmroot core.
- Transparent proxying is allowed only for operations published by the
  Adapter's OpenAPI contract with deterministic permission mappings.
- Adding a provider changes its Adapter provider module and Realmroot
  configuration, not Realmroot core code.

This boundary is mandatory. Do not introduce another Realmroot authorization
model or a private Realmroot-to-Adapter account-connection protocol. Read
`docs/architecture.md` before changing authorization or provider boundaries.

## Verification

Run the narrowest relevant checks before committing. Documentation changes run
`pnpm run docs:check`; code changes also run the matching type, lint, unit,
integration, and build checks defined in `package.json`.
