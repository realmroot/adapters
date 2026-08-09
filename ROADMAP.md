# Roadmap

This roadmap communicates direction, not a compatibility or delivery-date
promise. Provider APIs and identity products change independently; milestones
may move when their security semantics change.

The roadmap has a deliberate terminal condition: a provider adapter is
deprecated when the provider implements compatible native Agent identity,
authorization, discovery, audit, and revocation. Adapter removal is a success
metric, not a loss of project scope.

## Project status

The project is being bootstrapped. No adapter is currently supported for
production use.

| Provider | Identity level | Product UI | Provider audit | Status |
| --- | --- | ---: | ---: | --- |
| GitHub | Brokered | Shared App actor + content attribution | Shared App actor | Alpha vertical slice |
| Cloudflare | Native service principal | Token management | Per-Agent token actor | Design |
| Linear | Brokered native App actor | Per-operation Agent name/avatar on supported writes | Shared App actor | Experimental slice |

## Phase 0 — Contract and security baseline

- [x] Publish Agent-native Resource Server Profile 0.1 in the Realmroot main
  repository.
- [x] Add date-stamped Profile 0.1 capability reports for the initial three
  providers.
- [x] Define the machine-readable provider capability manifest from the stable
  profile IDs.
- Define the canonical provider module contract around identity, authorization,
  provider-permission scopes, transparent proxying, transformations, revocation,
  and audit.
- Define conformance tests shared by every provider.
- Define a stable error taxonomy without leaking provider SDK types.
- Define deployment, secret storage, observability, and release conventions.
- Publish an explicit threat model.

Exit criteria: a provider can declare its real identity capabilities and pass
the shared security contract without provider-specific exceptions in the core.

## Protocol publication and platform adoption

The canonical implementation baseline is Realmroot's
[Agent-native Resource Server Profile](https://github.com/realmroot/realmroot/blob/main/docs/integrations/agent-native-resource-server-profile.md).
Adapter implementations and provider evidence will evolve it toward an open
Agent-native access profile rather than a Realmroot-only integration
convention.

- Separate normative protocol requirements from Realmroot implementation
  details.
- Publish versioned metadata, token, Agent principal, Resource, scope, audit,
  revocation, and migration requirements.
- Publish a provider adoption guide and minimal native Resource Server example.
- Make the conformance suite runnable by platform vendors without deploying an
  adapter.
- Establish public compatibility and change-governance rules.
- Work with providers to replace adapter paths with direct native paths.

Exit criteria: a platform team can implement and verify direct Agent access
from the public protocol profile and conformance suite without depending on
provider-specific Realmroot adapter code.

## Phase 1 — GitHub vertical slice

GitHub establishes the compatibility baseline for a provider that cannot
represent each Realmroot Agent as a native actor.

- GitHub App installation and repository selection.
- GitHub REST transparent proxy through installation tokens.
- Provider-permission scopes and repository downscoping.
- Isolated attribution transformers for issues and comments.
- DPoP Agent boundary and provider credential isolation.
- Provider-native HTTP semantics and audit correlation.
- Explicit brokered identity declaration; no false native-Agent claim.

Implemented in the alpha slice:

- [x] installation-specific RFC 9728 Resource boundary and OpenAPI discovery;
- [x] Realmroot JWT and DPoP validation;
- [x] transparent GitHub REST forwarding through short-lived installation credentials;
- [x] provider permission scopes and repository-downscoped credentials;
- [x] trusted visible and machine-readable Agent attribution;
- [x] Cloudflare Worker runtime with durable D1 replay and audit state;
- [x] one Provider Connection per Realmroot owner with signed broker revocation;

Remaining before production readiness:

- [ ] audit retention, operational queries, and production observability policy;
- [ ] installation/repository lifecycle webhooks and provider-originated invalidation;
- [ ] additional attribution transformers and delegated-user mode;
- [ ] deployment, secret rotation, and live-provider conformance automation.

Exit criteria: every write can be traced from the Realmroot Agent and approved
Resource to the GitHub App/user actor, provider request, and resulting URL.

## Phase 2 — Cloudflare service principals

Cloudflare establishes native non-human identity and provider-side audit.

- Administrator connection flow for account-owned tokens.
- One dedicated service principal per authorized Realmroot Agent.
- Account and zone Resource discovery.
- Permission-group and resource-policy mapping.
- Token issuance, rotation, disablement, expiration, and deletion.
- Representative DNS and Workers operations.
- Audit-log correlation by token ID and token name.

Exit criteria: Cloudflare's own audit log identifies the dedicated Agent
service principal for each representative operation.

## Phase 3 — Linear shared native App actor

Linear establishes provider-native App identity with per-operation Agent
attribution. It does not provision one Linear principal per Realmroot Agent.

- OAuth installation with `actor=app`.
- Workspace and team Resource discovery.
- Agent mention and delegation scopes for the shared App user.
- Issues, comments, projects, and documents through the original GraphQL API.
- Trusted Agent name and avatar mapping through provider-supported fields.
- Agent lifecycle, permission-change, and revocation webhooks.

Implemented in the experimental slice:

- [x] two-stage user identity and `actor=app` authorization behind one Provider
  Connection;
- [x] multiple workspace contexts with encrypted rotating credentials;
- [x] transparent forwarding of the original GraphQL endpoint;
- [x] operation-aware enforcement of Linear's official OAuth scopes;
- [x] trusted Agent display attribution on issue and comment creation;
- [x] permission-change and OAuth-revocation lifecycle webhooks;
- [x] production OAuth, read GraphQL, `issueCreate`, and native display
  acceptance.

Remaining before preview:

- [ ] live refresh, revocation, and webhook lifecycle acceptance;
- [ ] production observability, secret rotation, and provider conformance
  automation.

Exit criteria: the shared Realmroot App actor remains explicit, supported
create operations show the originating Realmroot Agent without content
footers, and audit correlation never misrepresents that display alias as a
separate Linear principal.

## Provider waves

All providers previously discussed by the project are part of the visible
portfolio. A wave expresses evaluation order and the identity question it is
intended to answer; it is not a delivery-date commitment.

### Wave 1 — Identity-model baseline

- **GitHub** — brokered application identity and trusted visible attribution.
- **Linear** — shared native App actor with per-operation Agent attribution.
- **Cloudflare** — dedicated service-principal identity and provider-side audit.

These three establish the conformance and implementation patterns used by all
later provider proposals.

### Wave 2 — Developer platform identities

- **GitLab** — project/group service accounts and bot users.
- **Bitbucket** — repository/project/workspace access-token users.
- **Vercel** — integration identity, scoped project access, and audit
  correlation.

Exit criteria: each proposal proves whether a dedicated provider principal can
be provisioned per Realmroot Agent without simulating a human account, and
documents the operational cost of that identity lifecycle.

### Wave 3 — Collaboration applications

- **Slack** apps and bot actors.
- **Microsoft Teams** bots and application actors.
- **Jira** apps.
- **Confluence** apps.
- **Notion** connections and integration actors.
- **Asana** OAuth applications.

Exit criteria: each proposal distinguishes the provider's security principal
from UI display attribution, identifies the exact operations that need trusted
identity transformation, and preserves the provider's original API rather than
introducing adapter-owned business endpoints.

### Wave 4 — Cloud workload identities

- **AWS** IAM roles and role sessions.
- **Microsoft Entra** service principals and workload identities.
- **Google Cloud** service accounts and workload identity federation.

Exit criteria: each proposal maps a Realmroot Agent to a short-lived workload
principal, scopes it to exact cloud Resources, and correlates it with the
provider's native audit log without long-lived credentials reaching the Agent.

## Proposal gate

A provider moves from `proposal` to `design` only after its provider report
documents:

- actor semantics and identity fidelity;
- Resource and provider-permission models;
- installation, credential, rotation, and revocation lifecycle;
- product UI and audit visibility;
- a safe transparent-proxy vertical slice;
- native-readiness gaps and adapter retirement condition;
- provider tier, marketplace review, quota, and operational constraints.

Identity fidelity is evaluated before API breadth. A large API surface never
compensates for an identity claim the provider cannot enforce or audit.

## Non-goals

- Creating a human account per Agent to simulate native identity.
- Claiming that a display name is a distinct security principal when the
  provider records only a shared application actor.
- Exposing provider credentials to Agents.
- Replacing provider APIs with adapter-owned business endpoints or schemas.
- Silently weakening DPoP or provider permission boundaries.
- Permanently proxying a provider after it supports a compatible native
  Realmroot Resource Server integration.
- Treating adapter count or proxied API breadth as the project's primary
  success metric.
