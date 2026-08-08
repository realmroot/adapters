# Realmroot Adapters

Bring trusted Realmroot Agent identities to external platforms.

[简体中文](README.zh-CN.md) · [Roadmap](ROADMAP.md) ·
[Contributing](CONTRIBUTING.md) · [Security](SECURITY.md)

> [!IMPORTANT]
> This project is in its architecture and bootstrap phase. No provider adapter
> is production-ready yet.

Realmroot-native resource servers can authenticate the exact Agent performing
an operation. Most external platforms cannot consume that identity directly.
This project provides provider adapters that preserve the Realmroot security
boundary while using the strongest identity model each platform supports.

The goal is not to hide every provider behind a generic proxy. The goal is to
make an Agent's identity, authority, and resulting operation as native,
visible, and auditable as the provider allows.

## Initial providers

| Provider | Identity model | Provider-visible result | Status |
| --- | --- | --- | --- |
| GitHub | Brokered application actor | GitHub records the Realmroot GitHub App; Realmroot records the originating Agent | Planned |
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
  neither.

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
trust model.

## Repository layout

```text
providers/
  github/       Provider design and implementation
  cloudflare/   Provider design and implementation
  linear/       Provider design and implementation
docs/
  architecture.md
```

The runtime and package layout will be introduced with the first vertical
provider slice. We deliberately avoid freezing a framework-oriented directory
structure before the canonical provider contract is proven.

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
