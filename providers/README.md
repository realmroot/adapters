# Providers

Each provider directory owns its external-platform implementation, capability
manifest, provider-specific tests, fixtures, and operational documentation.

## Required provider documentation

Before implementation, each provider README must define:

- identity level and provider-native actor;
- product and audit visibility;
- installation and authorization flow;
- credential lifecycle;
- Realmroot Resource mapping;
- scope and provider-permission mapping;
- supported operations;
- idempotency strategy;
- revocation signals;
- provider tier, review, or marketplace requirements;
- known limitations that affect security or identity claims.

## Status values

- `proposal` — evidence and scope are under discussion;
- `design` — accepted for implementation;
- `experimental` — runnable but unsupported and subject to contract changes;
- `preview` — suitable for isolated evaluation with documented limitations;
- `stable` — covered by the published compatibility and security policy;
- `deprecated` — replacement or removal path is published.

No provider may be marked stable until it passes the shared conformance suite
against a real isolated provider installation.
