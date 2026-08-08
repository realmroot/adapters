# The native Agent protocol vision

## The initiative

Agents should not need a permanent, provider-specific proxy to participate in
the internet.

An Agent should be able to present one stable identity and narrowly delegated
authority directly to the platform that owns a Resource. The platform should
be able to authenticate that Agent, distinguish it from its controller and
runtime host, authorize an exact operation, display it as a native actor where
appropriate, audit its work, and revoke its access.

Realmroot Adapters exists to bridge the period before platforms offer that
boundary themselves. It is also a public implementation laboratory for the
protocol profile that can make the bridge unnecessary.

We invite API providers, SaaS platforms, identity systems, Agent runtimes, and
security researchers to evolve and implement this profile in the open.

## Not a proprietary gateway

The intended protocol is an interoperable profile built from open Web and OAuth
standards plus the minimum Agent-specific semantics those standards do not
define on their own.

Realmroot is one issuer and implementation. A platform-native integration must
not require all traffic to traverse Realmroot infrastructure, and the protocol
must not prevent other conforming issuers, Agent runtimes, or authorization
systems from participating.

This document describes the direction of the profile. It is not a formal
standards-body specification. The versioned, normative implementation baseline
is maintained in Realmroot's
[Agent-native Resource Server Profile](https://github.com/realmroot/realmroot/blob/main/docs/integrations/agent-native-resource-server-profile.md);
this repository assesses providers against its stable capability IDs.

## What a platform implements

An Agent-ready platform owns an Agent-facing protocol boundary alongside its
normal API. That boundary provides the following capabilities.

### Resource discovery

- Publish protected-resource metadata for the exact Resource boundary.
- Advertise the live API contract through a standard service-description link.
- Publish the scopes that the Resource itself understands and enforces.
- Keep resource selection and business authorization with the platform that
  owns the data.

The current profile builds on RFC 9728 protected-resource metadata, RFC 8631
`service-desc` links, and OpenAPI contracts.

### Stable Agent identity

- Accept a stable Agent identifier independent of a particular machine,
  process, session, or credential.
- Distinguish the Agent from the human or organization controlling it.
- Preserve the Agent as a first-class actor in provider audit records.
- Resolve safe display metadata without treating mutable display data as
  authentication or authorization evidence.

The current profile represents delegated actor context with RFC 8693 actor
claims and discovers safe public Agent display metadata separately.

### Proof-bound delegated authority

- Accept short-lived authority for one audience, Resource, and scope set.
- Require proof of possession so a stolen bearer value is insufficient.
- Validate the effective request URI and method at the Resource boundary.
- Support expiry, revocation, replay protection, and key rotation.

The current profile uses RFC 9449 DPoP and OAuth authorization-server metadata,
token exchange, and revocation capabilities where applicable.

### Native authorization

- Map Agent authority to the platform's real Resource and permission model.
- Make the final allow-or-deny decision inside the provider boundary.
- Apply the intersection of Agent authority, controller delegation, provider
  account policy, Resource membership, and operation requirements.
- Reject removed Resources, reduced permissions, and revoked grants without a
  permissive fallback.

### Native identity experience

- Represent the Agent as a native non-human actor when the product has an actor
  model.
- Make non-human status visible rather than impersonating a human user.
- Where useful, allow mention, assignment, delegation, ownership, or Agent
  session primitives.
- Display the originating Agent without relying on editable content footers.

A platform may first implement audit-only service-principal identity and later
add a richer product experience. The capability level must remain explicit.

### Audit and lifecycle

- Record the stable Agent, controller authority, Resource, operation, result,
  and provider-native request correlation.
- Expose installation, permission-change, and revocation signals.
- Preserve historical actor identity after credentials are rotated or removed.
- Never require provider secrets to be exposed to the Agent runtime.

## Direct interaction

With a native platform boundary, the request path becomes:

```text
1. Agent discovers the platform Resource and live API contract.
2. Agent requests authority for the exact Resource and scopes.
3. The controller or policy authority approves that request.
4. The Agent receives short-lived, proof-bound authority for the platform.
5. The Agent calls the platform directly.
6. The platform authenticates and records the stable Agent actor.
7. Revocation stops subsequent calls at the platform boundary.
```

No adapter owns a provider refresh token, translates an identity, or proxies
the business request.

## The role of this repository

Each adapter should produce four artifacts:

1. **Compatibility implementation** — a safe temporary path for current users.
2. **Capability manifest** — an honest machine-readable statement of the
   provider's actor, Resource, credential, audit, and revocation behavior.
3. **Native-readiness gap report** — the specific protocol capabilities the
   provider does not yet expose.
4. **Retirement plan** — the condition and migration path for deleting the
   adapter when native support arrives.

The shared conformance suite should test both adapters and native provider
implementations. A provider that passes directly should not need an adapter.

## Adoption path for platform teams

Platform teams do not need to redesign their entire authorization system at
once. A practical adoption sequence is:

1. Introduce a distinct, auditable non-human principal.
2. Publish Resource and scope discovery.
3. Accept short-lived proof-bound Agent authority.
4. Record stable Agent identity in the platform audit trail.
5. Add native Agent display and collaboration primitives where relevant.
6. Run the public conformance suite.
7. Migrate connected users from the adapter path to direct access.

The platform continues to own accounts, Resources, permissions, policy,
business operations, and audit retention throughout the migration.

## How success is measured

The project's strongest success signals are:

- a provider implements the profile at its own Resource Server boundary;
- a Realmroot Agent calls that provider directly with no compatibility proxy;
- the provider natively identifies and audits the Agent;
- an adapter is deprecated and removed;
- the protocol and conformance suite work with implementations beyond
  Realmroot.

The number of permanent adapters is not the goal. Native adoption is.
