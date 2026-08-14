# Architecture

## Purpose

Realmroot Adapters bridges a stable Realmroot Agent principal to external
platforms that do not implement the Realmroot-native Resource Server contract.
The bridge must preserve the Agent identity and approved authority without
misrepresenting what the provider can natively enforce or display.

This is a transitional architecture. Its intended outcome is for the provider
to implement the Agent-facing protocol boundary itself, after which the
provider adapter leaves the request path.

## Architecture invariant

Realmroot sees every Adapter as one standard external authorization server and
protected Resource. An Adapter never creates a third Realmroot authorization
model or a private account-connection protocol.

- Realmroot owns stable Agent identity, controller approval, Agent grants, one
  logical Connector per provider, and that Connector's independent
  authentication and resource-authorization facets.
- The Adapter owns provider authorization, credentials, refresh, revocation,
  lifecycle state, scope mapping, operation publication, final DPoP-token
  issuance, and provider API execution.
- Provider-specific OAuth stages, authorization-detail fields, webhook payloads,
  credentials, permissions, and API routing stay outside Realmroot core.
- The Agent calls only operations explicitly published by the Adapter's
  OpenAPI contract. Transparent proxying preserves provider semantics but never
  permits arbitrary upstream URLs or unpublished operations.
- Adding a provider changes the Adapter provider module and Realmroot
  configuration, not Realmroot core code.

This boundary is mandatory. Any proposal that moves provider state or decisions
into Realmroot, adds another authorization model, or introduces a private
Realmroot-to-Adapter protocol requires an architecture decision and security
review before implementation.

## Target architecture

```text
Transitional path

Realmroot Agent -> provider adapter -> external provider API

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
  DPoP proof + short-lived Adapter authority
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

The adapter is both the external authorization server and the protected
resource boundary. Realmroot manages one logical Connector per provider and
the controller-facing account connection, while the Adapter owns provider
OAuth details, credentials, webhook state, and final Agent-token issuance.
Realmroot returns that final token unchanged and does not interpret provider
fields inside authorization details.

The adapter terminates the Agent-facing request but does not weaken it. A
provider bearer credential may exist behind the adapter only when required by
the provider. It is never returned across the Agent boundary.

## Deployment boundary

The adapter is deployed as an independent Cloudflare Worker. It does not run
inside the Realmroot Worker and does not share Realmroot's database. Provider
bindings and encrypted provider credentials stay in Adapter D1. Realmroot
stores only its Connector client credentials, the controller-visible provider
connection identity, and the resource authorization record. Provider
credentials never cross the Agent boundary. The Worker runtime uses Web Crypto
and Fetch APIs without a Node process or filesystem.

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
provider-delegated
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
- **Scope mapping** — expose provider permissions in Realmroot's scope model and
  translate approved scopes back to the provider credential.
- **Credentials** — acquire, cache, rotate, revoke, and destroy provider
  credentials according to provider semantics.
- **Proxy** — preserve the provider's original method, path, query, body,
  response, and error semantics wherever the provider credential permits.
- **Transformations** — isolate the small operation set that requires
  compatibility behavior such as content attribution.
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
3. Translate approved scopes into the provider's native permission model.
4. Resolve the connected provider account and provider-native actor.
5. Acquire the narrowest valid provider credential without exposing it.
6. Apply a provider-owned transformer only when the operation requires one.
7. Stream the original operation to the provider and let it enforce endpoint
   permissions.
8. Record one correlated execution result at the request boundary.
9. Return the provider response without exposing credentials or internal
   principal data.

## Failure and revocation

Provider failures are translated into a finite stable taxonomy. Adapters retain
the original cause for boundary diagnostics but do not leak provider SDK error
types inward.

The adapter does not retry writes or introduce an idempotency contract that the
provider API does not have. Clients follow the provider's documented retry and
idempotency semantics.

Revocation is fail-closed. A removed installation, disabled principal, reduced
permission, removed Resource, expired grant, or failed credential renewal stops
subsequent access.

Provider lifecycle deliveries terminate at the Adapter boundary. The provider
module verifies their authenticity, durably deduplicates them, updates its own
authority state, and makes subsequent token issuance and API execution fail
closed. Provider event names, payloads, ordering cursors, and stored context do
not cross into Realmroot.

## Audit record

Every provider write and security-sensitive operation records:

- immutable Realmroot Agent issuer and subject;
- controller authority and approved grant;
- Realmroot Resource and scopes;
- provider account and provider Resource;
- provider actor type and stable identifier;
- identity level and visibility claims;
- provider method and path;
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
- transparent request and response forwarding;
- revocation and permission reduction;
- normalized error behavior;
- audit completeness.

Provider-specific tests then prove the real external boundary against an
isolated test installation or recorded contract fixture. Live-provider tests
must never depend on contributor personal accounts in normal pull-request CI.

The same conformance suite should eventually run against a provider's native
implementation. Passing it without an adapter is the technical entry condition
for migration to the direct path.
