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
| GitHub | Brokered | Shared App actor | Shared App actor | Design |
| Cloudflare | Native service principal | Token management | Per-Agent token actor | Design |
| Linear | Native Agent | Per-Agent name/avatar | App/Agent actor | Design |

## Phase 0 — Contract and security baseline

- [x] Publish Agent-native Resource Server Profile 0.1 in the Realmroot main
  repository.
- [x] Add date-stamped Profile 0.1 capability reports for the initial three
  providers.
- [ ] Define the machine-readable provider capability manifest from the stable
  profile IDs.
- Define the canonical provider module contract around identity, authorization,
  discovery, credentials, operations, revocation, idempotency, and audit.
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
- Organization and repository discovery.
- Installation-token and delegated-user modes.
- Issues, pull requests, comments, and reviews.
- DPoP Agent boundary and provider credential isolation.
- Idempotent writes and audit correlation.
- Explicit brokered identity declaration; no false native-Agent claim.

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

## Phase 3 — Linear native Agents

Linear establishes the native Agent experience.

- OAuth installation with `actor=app`.
- Workspace and team Resource discovery.
- Agent mention and delegation scopes.
- Issues, comments, projects, documents, and Agent Sessions.
- Trusted Agent name and avatar mapping through provider-supported fields.
- Agent lifecycle, permission-change, and revocation webhooks.

Exit criteria: a Realmroot Agent is visible in Linear without content footers,
can participate in a native Agent workflow, and remains correlated with its
Realmroot principal and authority.

## Candidate providers

Future providers are evaluated by identity fidelity before API breadth.

### Native Agent candidates

- Platforms that introduce installable Agent members, Agent sessions, or
  trusted per-operation Agent attribution.

### Native service-principal candidates

- AWS IAM roles and role sessions
- Microsoft Entra service principals and workload identities
- Google Cloud service accounts and workload identity federation
- GitLab project/group bot users and service accounts
- Bitbucket repository/project/workspace access-token users
- Vercel integrations

### Brokered adapter candidates

- Slack apps
- Microsoft Teams bots
- Jira and Confluence apps
- Notion connections
- Asana OAuth applications

A candidate moves into the committed roadmap only after a provider proposal
documents its actor semantics, Resource model, credential lifecycle, audit
surface, revocation behavior, safe initial operation set, native-readiness gaps,
and the condition under which its adapter can be retired.

## Non-goals

- Creating a human account per Agent to simulate native identity.
- Claiming that a display name is a distinct security principal when the
  provider records only a shared application actor.
- Exposing provider credentials to Agents.
- Providing an unrestricted generic pass-through API.
- Silently weakening DPoP or provider permission boundaries.
- Permanently proxying a provider after it supports a compatible native
  Realmroot Resource Server integration.
- Treating adapter count or proxied API breadth as the project's primary
  success metric.
