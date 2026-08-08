# Realmroot Adapters

Bring trusted Realmroot Agent identities to external platforms.

[简体中文](README.zh-CN.md) · [Roadmap](ROADMAP.md) ·
[Contributing](CONTRIBUTING.md) · [Security](SECURITY.md)

> [!IMPORTANT]
> This project is in alpha. The GitHub vertical slice runs as an independent
> Cloudflare Worker with durable D1 state, but provider lifecycle and
> revocation handling are not production-ready yet.

Realmroot-native resource servers can authenticate the exact Agent performing
an operation. Most external platforms cannot consume that identity directly.
This project provides provider adapters that preserve the Realmroot security
boundary while using the strongest identity model each platform supports.

## A bridge designed to disappear

Realmroot Adapters is a transitional compatibility layer, not the destination.
It exists only while external platforms cannot directly accept a stable Agent
identity, Agent-bound authority, and proof-of-possession credentials.

Our end state is an open, interoperable Agent-native access protocol profile
implemented by platforms at their own resource boundaries. A conforming
platform can discover and authenticate an Agent, authorize it for exact
Resources and scopes, record it as a native actor, and revoke its authority
without an adapter in the request path.

```text
Today
Agent -> Realmroot -> Adapter -> Platform API

End state
Agent -- Realmroot-issued authority --> Agent-native Platform API
```

Adapters serve three temporary purposes:

- provide compatibility for platforms that have not implemented the protocol;
- document the exact native-identity and authorization gaps in each platform;
- provide a migration path and conformance evidence that help the platform
  adopt direct Agent access.

When a platform implements the native protocol profile, its adapter should be
deprecated and removed. Success is not an ever-growing permanent proxy layer;
success is fewer adapters because more platforms recognize Agents natively.

We invite API and platform builders to implement this protocol profile and help
evolve it in the open. Read [The native Agent protocol vision](docs/native-agent-protocol.md)
for the platform contract, adoption path, and current standards foundation.

## Initial providers

| Provider | Identity model | Provider-visible result | Status |
| --- | --- | --- | --- |
| GitHub | Brokered application actor | GitHub records the Realmroot GitHub App; issue bodies identify the originating Agent | Alpha |
| Cloudflare | Native service principal | A dedicated account-owned token identifies the Agent in Cloudflare audit logs | Planned |
| Linear | Native Agent actor | The Agent appears in Linear with its name and avatar and can participate in Agent workflows | Planned |

See [the roadmap](ROADMAP.md) for delivery phases and future provider
candidates.

## Identity levels

Every adapter declares the identity level it can honestly provide:

### Native Agent

The provider has an Agent or application-member primitive. The Agent can be
visible in the product and the provider retains a first-class actor record.
Linear is the initial target for this level.

### Native service principal

The provider recognizes a dedicated non-human principal and records it in its
own audit trail, even when the principal is not rendered as a collaborator in
the product UI. Cloudflare account-owned tokens are the initial target for this
level.

### Brokered

The provider recognizes the shared adapter application, but cannot represent
each originating Realmroot Agent as a distinct native actor. Realmroot's audit
chain remains authoritative for the originating Agent. GitHub currently falls
into this level unless a separate GitHub identity is provisioned for every
Agent.

Adapters must not claim a stronger identity level than the provider actually
enforces.

## What an adapter owns

A provider adapter is responsible for:

- exposing RFC 9728 protected-resource metadata and OpenAPI discovery;
- authenticating a DPoP-bound Realmroot Agent request;
- mapping the authenticated Agent to a provider-native actor when available;
- keeping provider credentials outside Agent and CLI visibility;
- discovering provider resources and mapping them to Realmroot Resources;
- mapping Realmroot scopes to provider permissions and resource boundaries;
- acquiring, rotating, revoking, and safely storing provider credentials;
- enforcing idempotency for provider writes;
- correlating Realmroot audit records with provider actors and resulting
  resources;
- declaring when identity is visible in product UI, audit logs, both, or
  neither;
- publishing the provider's native-readiness gaps and a concrete adapter exit
  condition.

## Security invariants

All adapters share the same non-negotiable security properties:

- The Agent-facing boundary requires DPoP. There is no bearer fallback.
- Provider secrets and refresh credentials are never returned to the Agent.
- Actor display data is derived from the authenticated Realmroot principal,
  never trusted from Agent-supplied request content.
- Provider permissions are intersected with the approved Realmroot Resource
  and scopes for every request.
- Revocation, provider permission reduction, or resource removal stops future
  access.
- Provider-visible identity is not treated as stronger than the provider's
  actual authorization and audit semantics.

Read [Architecture](docs/architecture.md) for the initial module boundaries and
trust model, and [The native Agent protocol vision](docs/native-agent-protocol.md)
for the adapter-free end state.

## Repository layout

```text
providers/
  github/       Provider capability report
  cloudflare/   Provider design and implementation
  linear/       Provider design and implementation
docs/
  architecture.md
  github-design.md
  native-agent-protocol.md
specs/
  github-adapter.feature
src/
  core/         Shared DPoP, AgentInfo, attribution, errors, and idempotency
  providers/    Thin provider credential and HTTP boundaries
  storage/      Worker-owned D1 runtime state
  worker.ts     Cloudflare Worker entrypoint
migrations/     D1 schema
```

## Run the GitHub vertical slice

The runtime is a Cloudflare Worker, not a Node server. Node 24 and pnpm 10 are
development tools only. Local operation also needs a running Realmroot
deployment and a GitHub App with its OAuth callback and setup callback enabled.

```bash
pnpm install
cp .dev.vars.example .dev.vars
pnpm exec wrangler d1 migrations apply realmroot-adapters-db --local
pnpm dev -- --port 4103
```

After configuring the GitHub App credentials, register one native Resource
Server for GitHub. Installations are account-connection contexts; they are not
separate Resource Servers and never appear in the audience URL:

```json
{
  "identifier": "github",
  "resourceUrl": "http://127.0.0.1:4103/github",
  "ownerOrganizationId": "org_platform",
  "authorizationDetails": [{ "type": "github_installation" }],
  "enabled": true,
  "availableToAgents": true,
  "visibility": "public"
}
```

Set `GITHUB_APP_ID`, `GITHUB_PRIVATE_KEY`, `GITHUB_CLIENT_ID`, and
`GITHUB_CLIENT_SECRET` in the ignored `.dev.vars` file. Both GitHub-downloaded
PKCS#1 keys and unencrypted PKCS#8 PEM keys are accepted.

Configure the GitHub App callbacks as:

```text
Callback URL: http://127.0.0.1:4103/github/oauth/callback
Setup URL:    http://127.0.0.1:4103/github/account-connection-installations
```

For deployment, store the key without putting it in source or Wrangler vars:

```bash
pnpm exec wrangler secret put GITHUB_APP_ID
pnpm exec wrangler secret put GITHUB_PRIVATE_KEY < github-app.private-key.pem
pnpm exec wrangler secret put GITHUB_CLIENT_ID
pnpm exec wrangler secret put GITHUB_CLIENT_SECRET
```

The first slice needs repository Metadata read and Issues read/write. Each
Realmroot account has at most one GitHub Connection, and that Connection may
contain multiple GitHub App installations. Install the App only on repositories
that should be available through that account connection.

The current operations are intentionally narrow:

```text
GET  /repositories
POST /repos/{owner}/{repository}/issues
```

Run the project checks with:

```bash
pnpm run typecheck
pnpm test
pnpm run types:check
pnpm run lint
pnpm run build
pnpm run docs:check
```

## Contributing

Provider expertise is especially welcome. A new provider proposal should
explain:

1. its native actor types;
2. where those actors are visible;
3. its installation and credential lifecycle;
4. its resource and permission model;
5. its revocation and audit behavior;
6. which operations form a safe initial vertical slice.

Start with the [provider proposal template](https://github.com/realmroot/adapters/issues/new?template=provider.yml)
and read [CONTRIBUTING.md](CONTRIBUTING.md).

## License

Licensed under the [Apache License 2.0](LICENSE).
