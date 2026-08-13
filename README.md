# Realmroot Adapters

Bring trusted Realmroot Agent identities to external platforms.

[简体中文](README.zh-CN.md) · [Roadmap](ROADMAP.md) ·
[Contributing](CONTRIBUTING.md) · [Security](SECURITY.md)

> [!IMPORTANT]
> This project is in alpha. The GitHub vertical slice runs as an independent
> Cloudflare Worker with a standard external OAuth authorization boundary,
> durable D1 state, and provider-webhook lifecycle invalidation.

> [!NOTE]
> Every Adapter is a standard external authorization server and protected
> Resource from Realmroot's perspective. Realmroot owns Agent identity,
> approval, grants, and one logical Connector per provider; the Adapter owns all
> provider-specific authorization, credentials, lifecycle, token issuance, and
> API execution. This boundary is an architecture invariant. See
> [Architecture](docs/architecture.md#architecture-invariant).

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
Agent -> Adapter OAuth AS -> Adapter Resource Server -> Platform API

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

## Provider portfolio

The roadmap covers the full provider portfolio below. `Proposal` means the
provider is in the formal assessment queue; it does not claim that its target
identity model has already passed a capability review.

| Provider | Target identity model | Target provider-visible result | Wave | Status |
| --- | --- | --- | ---: | --- |
| GitHub | Provider-delegated application actor | Shared GitHub App actor with trusted Agent attribution | 1 | Alpha |
| Linear | Provider-delegated native App actor | Shared App user with trusted per-operation Agent attribution | 1 | Experimental |
| Cloudflare | Native service principal | Dedicated account-owned token actor in audit logs | 1 | Design |
| GitLab | Native service principal | Dedicated service account visible in groups, projects, and audit records | 2 | Proposal |
| Bitbucket | Native service principal | Repository, project, or workspace access-token actor | 2 | Proposal |
| Vercel | Native service principal | Dedicated integration identity with provider-side audit correlation | 2 | Proposal |
| Slack | Provider-delegated application actor | App/bot actor in conversations and platform audit surfaces | 3 | Proposal |
| Microsoft Teams | Provider-delegated application actor | Bot/application actor in Teams conversations | 3 | Proposal |
| Jira | Provider-delegated application actor | App actor on issues, comments, and workflow operations | 3 | Proposal |
| Confluence | Provider-delegated application actor | App actor on pages, comments, and content operations | 3 | Proposal |
| Notion | Provider-delegated integration actor | Integration actor on pages, databases, and comments | 3 | Proposal |
| Asana | Provider-delegated application actor | Application/delegated actor on tasks, projects, and comments | 3 | Proposal |
| AWS | Native service principal | IAM role session and CloudTrail actor correlated to the Agent | 4 | Proposal |
| Microsoft Entra | Native service principal | Workload identity/service principal in tenant audit records | 4 | Proposal |
| Google Cloud | Native service principal | Service account or federated workload principal in Cloud Audit Logs | 4 | Proposal |

See [the roadmap](ROADMAP.md) for wave goals, acceptance requirements, and the
rules for moving a proposal into implementation.

## Identity levels

Every adapter declares the identity level it can honestly provide:

### Native Agent

The provider authenticates each originating Agent as its own stable principal.
That Agent is visible in the product and retained as a first-class actor record.
No implemented provider currently reaches this level.

### Native service principal

The provider recognizes a dedicated non-human principal and records it in its
own audit trail, even when the principal is not rendered as a collaborator in
the product UI. Cloudflare account-owned tokens are the initial target for this
level.

### Provider delegated

The provider recognizes the shared adapter application, but cannot represent
each originating Realmroot Agent as a distinct native actor. Realmroot's audit
chain remains authoritative for the originating Agent. GitHub uses content
attribution; Linear provides stronger provider-native per-operation display
attribution, but both retain a shared application as the security principal.

Adapters must not claim a stronger identity level than the provider actually
enforces.

## What an adapter owns

A provider adapter is responsible for:

- exposing a standard OAuth authorization server to Realmroot, including
  authorization code, refresh, JWT bearer, token exchange, DPoP, and revocation;
- exposing RFC 9728 protected-resource metadata and OpenAPI discovery;
- authenticating the Adapter-issued DPoP-bound Agent token;
- mapping the authenticated Agent to a provider-native actor when available;
- keeping provider credentials outside Agent and CLI visibility;
- translating provider permissions into Realmroot scopes without inventing a
  second permission vocabulary;
- forwarding the provider's original HTTP API and preserving its semantics;
- acquiring, rotating, revoking, and safely storing provider credentials;
- transforming only operations that require compatibility behavior such as
  Agent attribution;
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
  linear-adapter.feature
src/
  core/         Shared HTTP lifecycle, DPoP, Agent Profile, and errors
  providers/    Isolated provider connections, permission translation, proxy, and transformations
  storage/      Worker-owned D1 runtime state
  worker.ts     Cloudflare Worker entrypoint
migrations/     D1 schema
```

## Run locally

The runtime is a Cloudflare Worker, not a Node server. Node 24 and pnpm 10 are
development tools only. Local operation also needs a running Realmroot
deployment and a GitHub App with its OAuth callback and setup callback enabled.

```bash
pnpm install
cp .dev.vars.example .dev.vars
pnpm exec wrangler d1 migrations apply realmroot-adapters-db --local
pnpm exec wrangler dev --port 4103 --local-upstream 127.0.0.1:4103
```

After configuring the GitHub App credentials, register the Adapter as one
external Resource Server and select the Realmroot GitHub Connector.
Installations are RFC 9396 authorization details; they are not separate
Resource Servers and never appear in the audience URL:

```json
{
  "identifier": "github",
  "resourceUrl": "http://127.0.0.1:4103/github",
  "connectorId": "YOUR_GITHUB_CONNECTOR_ID",
  "ownerOrganizationId": "YOUR_REALMROOT_ORGANIZATION_ID",
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
Realmroot Connector callback URL: https://id.realmroot.dev/api/auth/callback/github

Local callback URL: http://127.0.0.1:4103/github/oauth/callback
Local setup URL:    http://127.0.0.1:4103/github/account-connection-installations

Production callback URL: https://adapters.realmroot.dev/github/oauth/callback
Production setup URL:    https://adapters.realmroot.dev/github/account-connection-installations
```

Keep both production callback URLs on the same GitHub App. Realmroot uses its
callback when the Connector authentication facet is enabled; the Adapter uses
its callback for external resource authorization.

Configure the GitHub App webhook URL as
`https://adapters.realmroot.dev/github/webhooks`, select JSON payloads, and set
`GITHUB_WEBHOOK_SECRET` to an App webhook secret of at least 32 characters. The
adapter accepts only installation deletion, suspension, restoration, accepted
permission changes, and installation repository add/remove lifecycle signals.
Lifecycle request bodies are limited to 1 MiB. The adapter orders state by the
installation's GitHub `updated_at` value. Delivery GUIDs are idempotent event
identities, never ordering values. When GitHub emits distinct changes with the
same timestamp, restrictive suspension, repository selection, permission, and
repository-removal changes win; independent repository deltas are merged.
Accepted lifecycle changes update Adapter-owned installation authority.
Subsequent token issuance and API calls fail closed when an installation is
removed, suspended, or reduced.

For deployment, store the key without putting it in source or Wrangler vars:

```bash
pnpm exec wrangler secret put GITHUB_APP_ID
pnpm exec wrangler secret put GITHUB_PRIVATE_KEY < github-app.private-key.pem
pnpm exec wrangler secret put GITHUB_CLIENT_ID
pnpm exec wrangler secret put GITHUB_CLIENT_SECRET
pnpm exec wrangler secret put GITHUB_WEBHOOK_SECRET
```

The first connected App currently needs repository Metadata read and Issues
read/write. Each
Realmroot account has at most one GitHub Connection, and that Connection may
contain multiple GitHub App installations. Install the App only on repositories
that should be available through that account connection.

The GitHub Resource URL mirrors the original GitHub REST paths:

```text
GET  /github/installation/repositories
POST /github/repos/{owner}/{repo}/issues
PATCH /github/repos/{owner}/{repo}/labels/{name}
...all other GitHub REST paths accepted by the transparent proxy
```

Most requests are streamed transparently. The adapter parses a request body
only for a small registry of operations that need Agent attribution. GitHub
continues to define request and response schemas and endpoint behavior. OpenAPI
discovery publishes the subset GitHub documents for installation access tokens,
preserving alternative permission sets as OR and each set's required permissions
as AND. For every request, the adapter resolves the original method and path and
mints only one least-privileged permission set satisfied by the Realmroot token.

GitHub requires both `contents:write` and `workflows:write` when the Contents API
writes under `.github/workflows`; the adapter enforces that condition from the
actual upstream path. Standard OpenAPI security requirements cannot make a scope
conditional on a path-parameter value, so discovery advertises GitHub's two
static alternatives and adds `x-restish-security-alternatives` to select the
conjunction for a `.github/workflows/` path. Clients that ignore the extension
can ask for only `contents:write` on their first workflow-file request; the
adapter rejects that request until its Realmroot token contains both scopes.

GitHub's structured permission data also lists a `contents:write` plus
`workflows:write` alternative for reference and release writes. For releases,
GitHub documents that the condition depends on whether the resolved target
commit changes workflow files relative to the default branch; that fact is not
present in the proxy request. The adapter preserves GitHub's alternatives in
discovery and does not invent a request predicate or retry a provider write.

### Linear experimental slice

Create one Linear OAuth application with this callback:

```text
Local callback URL:      http://127.0.0.1:4103/linear/oauth/callback
Production callback URL: https://adapters.realmroot.dev/linear/oauth/callback
Production webhook URL:  https://adapters.realmroot.dev/linear/webhooks
```

Configure the webhook for permission changes and OAuth revocation. Do not
enable Agent Session events yet. Put `LINEAR_CLIENT_ID`,
`LINEAR_CLIENT_SECRET`, `LINEAR_WEBHOOK_SECRET`, and a random 32-byte
base64-encoded `LINEAR_CREDENTIAL_ENCRYPTION_KEY` in `.dev.vars`; use Wrangler
secrets for deployment.

Register the Adapter as one external Resource Server and select the Linear
Connector:

```json
{
  "identifier": "linear",
  "resourceUrl": "http://127.0.0.1:4103/linear",
  "connectorId": "YOUR_LINEAR_CONNECTOR_ID",
  "ownerOrganizationId": "YOUR_REALMROOT_ORGANIZATION_ID",
  "enabled": true,
  "availableToAgents": true,
  "visibility": "public"
}
```

The user sees one Linear Provider Connection. The adapter identifies the stable
Linear user, revokes the temporary user token, and authorizes the App actor for
that workspace. The workspace is the Provider Connection subject; it is not
represented by a separate authorization-detail type.

The Agent-facing API remains Linear's original GraphQL transport:

```text
POST /linear/graphql
```

Realmroot scopes use Linear's official names. The adapter evaluates the selected
GraphQL operation and only rewrites `issueCreate` and `commentCreate` to add
trusted Agent display fields. Because one GraphQL transport operation can carry
many differently scoped documents, the OpenAPI contract publishes one security
alternative per official Linear scope. Clients select the alternative matching
the document they are sending; for example, `read` for a viewer query or
`issues:create` for `issueCreate`.

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
