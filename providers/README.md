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
- known limitations that affect security or identity claims;
- gaps against the Agent-native access protocol profile;
- the native capability that would make the adapter unnecessary.

## Status values

- `proposal` — evidence and scope are under discussion;
- `design` — accepted for implementation;
- `experimental` — runnable but unsupported and subject to contract changes;
- `preview` — suitable for isolated evaluation with documented limitations;
- `stable` — covered by the published compatibility and security policy;
- `deprecated` — replacement or removal path is published.

No provider may be marked stable until it passes the shared conformance suite
against a real isolated provider installation.

## Adapter retirement

Provider modules are intentionally removable. When a provider can satisfy the
native protocol profile directly, maintainers publish a migration path, stop
adding adapter-only surface area, deprecate the module, and remove it after the
documented compatibility window.
