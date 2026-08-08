# Providers

Each provider directory owns its external-platform implementation, capability
manifest, provider-specific tests, fixtures, and operational documentation.

Provider capability reports assess
[Realmroot Agent-native Resource Server Profile 0.1](https://github.com/realmroot/realmroot/blob/main/docs/integrations/agent-native-resource-server-profile.md).
That upstream profile is the canonical capability definition; provider reports
must reference its stable IDs instead of redefining the protocol locally.

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

## Capability reporting

Every provider report pins the Agent-native Resource Server Profile version it
assessed and uses this legend:

| Mark | Meaning |
| --- | --- |
| ✅ | The provider implements the capability natively at its own boundary. |
| 🟨 | The provider does not implement it natively; the adapter owns or plans the compatibility bridge. |
| ❌ | Neither a provider-native implementation nor an adapter bridge is available. |
| ➖ | The capability is not applicable to the selected provider mode. |
| 🧪 | The provider implements an unstable preview or draft-aligned form; it is not yet a stable native dependency. |

Reports must cite the provider's public contract or reproducible conformance
evidence, state an assessment date and target conformance class, and distinguish
current implementation from planned adapter work. A provider-specific feature
that resembles an RFC is not marked ✅ unless its documented wire behavior
satisfies the capability.

Reports are re-reviewed when the upstream profile or provider contract changes.

## Adapter retirement

Provider modules are intentionally removable. When a provider can satisfy the
native protocol profile directly, maintainers publish a migration path, stop
adding adapter-only surface area, deprecate the module, and remove it after the
documented compatibility window.

A provider is not retirement-ready merely because its adapter fills every gap.
Every applicable mandatory capability must be implemented by the provider at
its own boundary, and the provider must authenticate and audit the stable Agent
without an adapter-owned identity or credential mapping.

A provider moves through this lifecycle:

```text
proposal -> design -> experimental -> preview -> stable
                                             |
                                             v
                             deprecated -> retired
```

The adapter may enter `deprecated` only when all of these are true:

1. every applicable **MUST** capability is provider-native ✅;
2. every applicable **COND** capability used by the provider is provider-native
   ✅;
3. `ACTOR-NATIVE` is ✅: the provider, not the adapter, authenticates and audits
   the stable Agent;
4. no provider request depends on an adapter-owned identity or provider
   credential mapping;
5. the shared conformance suite passes against the provider directly;
6. a documented migration preserves current grants and provides a rollback or
   roll-forward path.

`SHOULD` gaps require an explicit rationale and may block retirement when they
affect identity visibility, auditability, or revocation. After the published
compatibility window ends and supported users have migrated, the provider
module is removed and recorded as `retired`.
