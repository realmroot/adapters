# Cloudflare provider

Status: **experimental**

The Cloudflare adapter is a fail-closed REST transport backed by a normal
Cloudflare OAuth authorization. External users authorize their own Cloudflare
accounts. The Adapter encrypts and owns Cloudflare access and refresh tokens;
Realmroot stores only its Connector configuration and Provider Connection.

## Identity and credentials

- Provider actor: the Cloudflare user and OAuth Client.
- Cloudflare product visibility for the Agent: no.
- Cloudflare audit-log visibility for the Agent: no.
- Credential mode: Adapter-managed Cloudflare OAuth.
- Agent-facing credential: short-lived Adapter-issued DPoP token.
- Provider-facing credential: Adapter-owned Cloudflare Bearer token.

The Adapter does not create one API Token per Agent. Cloudflare receives the
delegated user OAuth identity, not the Realmroot Agent actor chain.

## REST contract

The generator pins Cloudflare `api-schemas` commit
`4e2f140437b8e356fb28631ece09c26efd7e781c` and the source SHA-256 in
`source.json`. It snapshots the authenticated `GET /oauth/scopes` catalog and
publishes only operations whose OAuth scope alternatives can be proven.

Current pinned inventory:

- official operations: 3,286;
- published OAuth operations: 2,652;
- fail-closed exclusions: 634;
- Restish OpenAPI size: about 6.3 MB.

`exclusions.json` records every unpublished method, path, operation ID,
permission metadata, and reason. Most exclusions have no `x-api-token-group`;
the remaining sensitive groups (including Billing, API Token management, and
OAuth Client management) have no matching scope in Cloudflare's authenticated
OAuth catalog. They are not forwarded until Cloudflare publishes enough
authority metadata or a reviewed explicit mapping is added.

## Runtime boundary

For every published operation the Adapter validates its DPoP token, Agent actor,
audience, replay, and operation scope; resolves and refreshes its Adapter-owned
Cloudflare credential; verifies the Provider scopes; and forwards to the fixed
`https://api.cloudflare.com/client/v4` origin.

The proxy strips inbound credentials, cookies, forwarding metadata, and
hop-by-hop headers. It preserves request semantics and streams the provider
response without automatic write retries. Audit stores only the Agent,
operation, path template, selected scope, status, request ID, CF-Ray, and
duration.

## Regeneration

Set `CLOUDFLARE_API_TOKEN` only for the generator process and run:

```text
pnpm run sync:cloudflare-openapi
```

Without that environment variable, the generator verifies and reuses the
committed OAuth scope snapshot. Tokens never enter generated files.
