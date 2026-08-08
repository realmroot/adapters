# Architecture

## Purpose

Realmroot Adapters bridges a stable Realmroot Agent principal to external
platforms that do not implement the Realmroot-native Resource Server contract.
The bridge must preserve the Agent identity and approved authority without
misrepresenting what the provider can natively enforce or display.

This is a transitional architecture. Its intended outcome is for the provider
to implement the Agent-facing protocol boundary itself, after which the
provider adapter leaves the request path.

## Target architecture

```text
Transitional path

Realmroot Agent -> provider adapter -> legacy provider API

Target path

Realmroot Agent -> provider-native Agent protocol boundary
                    authenticate Agent
                    authorize Resource and scopes
                    record native Agent actor
                    enforce revocation and audit
```

The target keeps business authorization with the platform that owns the
Resource. Realmroot supplies stable Agent identity and delegated authority; it
does not become a permanent proxy or a central catalog of provider permissions.

## Trust boundaries

```text
Realmroot Agent
  DPoP proof + short-lived Realmroot authority
            |
            v
Adapter Agent boundary
  authenticate Agent
  authorize Resource and scopes
  select provider actor
  create audit correlation
            |
            v
Provider boundary
  provider credential
  provider permissions
  provider resource
  provider-native actor and audit
```

The adapter terminates the Realmroot-facing request but does not weaken it. A
provider bearer credential may exist behind the adapter only when required by
the provider. It is never returned across the Agent boundary.

## Deployment boundary

The adapter is deployed as an independent Cloudflare Worker. It does not run
inside the Realmroot Worker and does not share Realmroot's database. Each
deployment owns its provider secrets and a D1 database containing only adapter
runtime state: DPoP replay claims, idempotent write outcomes, and correlated
audit events. The Worker runtime uses Web Crypto and Fetch APIs without a Node
process or filesystem.

## Identity model

Every operation records two identities:

- `originatingPrincipal`: the immutable Realmroot Agent issuer and subject;
- `providerActor`: the App, user, service principal, or native Agent recorded
  by the provider.

They may refer to the same conceptual Agent, but they are never conflated.

Each provider declares an identity level:

```text
native-agent
native-service-principal
brokered
```

It also declares two independent visibility properties:

- `visibleInProduct`
- `visibleInAuditLog`

A display alias does not become a separate provider principal merely because
it is rendered in the UI. The capability manifest must distinguish display
attribution from provider-enforced actor identity.

## Provider module boundaries

The initial contract will be proven through vertical provider slices before it
is stabilized. It is expected to contain these cohesive capabilities:

- **Identity** — resolve the provider actor for an authenticated Realmroot
  Agent and state the identity fidelity.
- **Authorization** — complete provider installation or delegation and retain
  the grant outside Agent visibility.
- **Discovery** — enumerate provider-owned objects and map them to canonical
  Realmroot Resources.
- **Scope mapping** — map approved Realmroot scopes to provider permissions and
  operation constraints.
- **Credentials** — acquire, cache, rotate, revoke, and destroy provider
  credentials according to provider semantics.
- **Operations** — implement an explicit supported operation set. No
  unrestricted provider pass-through is assumed.
- **Idempotency** — own provider-specific deduplication for complete write
  operations.
- **Revocation** — consume webhooks or verify provider state so removed
  authority stops access.
- **Audit** — correlate Agent, controller authority, Resource, scopes, provider
  actor, provider request, result, and resulting URL or resource ID.

The application behavior owns these contracts. Provider SDK objects, HTTP
responses, token formats, and error types remain inside provider adapters.

## Capability manifest

Every provider will publish a machine-readable, versioned manifest containing
at least:

```yaml
provider: linear
identity:
  level: native-agent
  visibleInProduct: true
  visibleInAuditLog: true
actorModes:
  - application
credentialModes:
  - oauth-authorization-code
  - oauth-client-credentials
resourceTypes:
  - workspace
  - team
revocationSignals:
  - webhook
  - token-rejection
```

The manifest is descriptive, not self-authorizing. Runtime behavior must still
validate every Agent request, Resource, scope, provider credential, and
provider response.

The manifest also records `nativeReadinessGaps` and `retirementCondition`.
These fields make adapter removal part of the provider contract rather than an
informal future intention.

## Request lifecycle

1. Authenticate the DPoP-bound Agent request.
2. Resolve the immutable Realmroot Agent principal.
3. Validate the requested operation against the approved Resource and scopes.
4. Resolve the connected provider account and provider-native actor.
5. Acquire the narrowest valid provider credential without exposing it.
6. Execute one explicitly supported provider operation.
7. Apply provider-specific idempotency to writes.
8. Record one correlated execution result at the request boundary.
9. Return a normalized result without provider credentials or internal
   principal data.

## Failure and revocation

Provider failures are translated into a finite stable taxonomy. Adapters retain
the original cause for boundary diagnostics but do not leak provider SDK error
types inward.

Only transient provider failures may be retried. The operation owner controls a
finite retry policy and retries writes only when their idempotency semantics are
proven.

Revocation is fail-closed. A removed installation, disabled principal, reduced
permission, removed Resource, expired grant, or failed credential renewal stops
subsequent access.

## Audit record

Every provider write and security-sensitive operation records:

- immutable Realmroot Agent issuer and subject;
- controller authority and approved grant;
- Realmroot Resource and scopes;
- provider account and provider Resource;
- provider actor type and stable identifier;
- identity level and visibility claims;
- operation and idempotency key;
- provider request correlation when available;
- result, resulting provider identifier, and URL;
- trace ID and timestamp.

Credentials, request authorization headers, refresh tokens, and sensitive body
content are never included.

## Conformance

Every provider will run the same contract suite for:

- DPoP enforcement;
- Resource and scope downscoping;
- credential non-disclosure;
- identity capability accuracy;
- reserved attribution-field rejection;
- idempotent representative writes;
- revocation and permission reduction;
- normalized error behavior;
- audit completeness.

Provider-specific tests then prove the real external boundary against an
isolated test installation or recorded contract fixture. Live-provider tests
must never depend on contributor personal accounts in normal pull-request CI.

The same conformance suite should eventually run against a provider's native
implementation. Passing it without an adapter is the technical entry condition
for migration to the direct path.
