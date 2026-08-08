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

## Native-readiness gaps and retirement

An account-owned token gives Cloudflare a native service principal, but the
platform does not yet consume the external stable Agent identity and its
proof-bound delegated authority directly. The adapter still provisions and
holds a Cloudflare credential on the Agent's behalf.

This adapter can be retired when Cloudflare can accept the stable Agent and
approved account or zone authority at its API boundary, issue or validate
short-lived proof-bound access, and preserve that Agent directly in Cloudflare
audit records without an adapter-owned token mapping.
