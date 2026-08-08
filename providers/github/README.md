# GitHub provider

Status: **design**

Identity level: **brokered**

## Actor semantics

GitHub installation access tokens attribute operations to the Realmroot GitHub
App. GitHub user access tokens attribute operations to the authorizing GitHub
user together with the App. Neither mode represents an arbitrary Realmroot
Agent as a distinct GitHub principal.

The provider must therefore preserve:

- the real GitHub App or delegated-user actor recorded by GitHub;
- the originating Realmroot Agent in the Realmroot audit chain.

It must not claim that a display footer changes GitHub's native actor.

## Initial Resource mapping

```text
GitHub App installation
  organization or user account
    repository
```

## Initial operations

- discover installations and selected repositories;
- create an issue;
- create a pull request;
- create issue and pull-request comments;
- create review comments;
- read representative repository and collaboration resources.

## Initial credential modes

- installation access token for App-attributed automation;
- GitHub App user access token for explicitly delegated user operations.

Provider credentials remain adapter-owned and are never returned to the Agent.

## Acceptance outcome

Every write is correlated with the Realmroot Agent, approved repository and
scopes, GitHub installation, real GitHub actor, provider request, and resulting
GitHub URL. The adapter declares brokered identity in discovery metadata.

## Known limitation

Distinct native GitHub identities would require a GitHub account or GitHub App
per Agent. That provisioning model is intentionally outside the initial scope.

## Profile 0.1 capability report

Assessment date: **2026-08-07**

Assessment target: GitHub Apps with installation access tokens and optional
user access tokens.

Retirement conformance class: **Federated Platform**

Evidence: [installation authentication](https://docs.github.com/en/apps/creating-github-apps/authenticating-with-a-github-app/authenticating-as-a-github-app-installation),
[user attribution](https://docs.github.com/en/apps/creating-github-apps/authenticating-with-a-github-app/authenticating-with-a-github-app-on-behalf-of-a-user),
[GitHub App versus OAuth App behavior](https://docs.github.com/en/apps/oauth-apps/building-oauth-apps/differences-between-github-apps-and-oauth-apps),
and [webhook events](https://docs.github.com/en/webhooks/webhook-events-and-payloads#installation).

This is a public-contract assessment, not conformance-test evidence. `🟨`
means the adapter design owns the compatibility work; it does not mean that
work is implemented yet.

| Profile capability | Status | Evidence and adapter responsibility |
| --- | --- | --- |
| `RESOURCE-HTTPS` | 🟨 | GitHub has an HTTPS API, but its token is not bound to the selected installation or repository as the profile's exact audience. |
| `RESOURCE-METADATA` | 🟨 | No RFC 9728 metadata is documented for GitHub API Resources; the adapter will publish the selected installation and repository boundary. |
| `API-SERVICE-DESC` | 🟨 | GitHub does not advertise its API contract from the selected Resource with RFC 8631. |
| `API-OPENAPI` | 🟨 | The adapter will expose only its supported operation slice and scope mapping. |
| `AS-METADATA` | 🟨 | GitHub App endpoints are documented individually rather than discovered through the required issuer metadata. |
| `OIDC-CONNECTION` | 🟨 | User access tokens and `/user` provide provider-specific connection semantics, not the complete OIDC contract. |
| `OAUTH-CODE` | ✅ | GitHub App user authorization uses the OAuth authorization-code flow. |
| `OAUTH-REFRESH` | ✅ | GitHub App user access tokens can be configured to expire and issue refresh tokens; this profile requires that mode. |
| `OAUTH-PKCE` | ✅ | GitHub documents `S256` PKCE for GitHub App and OAuth App web flows. |
| `OAUTH-RESOURCE` | 🟨 | GitHub uses installation and repository selection rather than RFC 8707 `resource`. |
| `CLIENT-REGISTRATION` | ➖ | The selected GitHub App is preregistered. |
| `CLIENT-MANAGEMENT` | ➖ | Dynamic client registration is not selected. |
| `ACTOR-CHAIN` | 🟨 | The adapter can preserve the Realmroot actor in its audit chain, but GitHub receives a GitHub credential. |
| `ACTOR-PROFILE` | 🟨 | The adapter validates `ai_agent`; GitHub does not consume that actor profile. |
| `ACTOR-NATIVE` | ❌ | GitHub attributes installation calls to the App and user-token calls to the user plus App, not to the originating Realmroot Agent. |
| `AGENT-DISPLAY` | ❌ | A footer or adapter-side record is not provider-native Agent display. |
| `ACTOR-ASSERTION` | 🟨 | GitHub App JWT authentication is provider-specific and is not the RFC 7523 Agent assertion grant required by this profile. |
| `TOKEN-EXCHANGE` | 🟨 | Installation-token minting is provider-specific, not RFC 8693 subject/actor exchange. |
| `JWT-ACCESS-TOKEN` | 🟨 | GitHub installation access tokens do not expose the required RFC 9068 claims to the Resource Server. |
| `DPOP` | 🟨 | GitHub API tokens are Bearer credentials; the adapter will require DPoP on its Agent-facing boundary. |
| `JWK-THUMBPRINT` | 🟨 | The adapter owns the inbound `cnf.jkt` binding. |
| `RICH-AUTHORIZATION` | ➖ | The initial GitHub mode does not use RFC 9396; installation and repository selection remain provider-specific. |
| `PUSHED-AUTHORIZATION` | ➖ | PAR is conditional on RFC 9396 use. |
| `AUTHORIZATION-CATALOG` | ➖ | The RFC 9396 catalog extension is not used; ordinary adapter Resource discovery still enumerates installations and repositories. |
| `TOKEN-REVOCATION` | 🟨 | GitHub exposes provider-specific token and installation lifecycle operations rather than the profile's RFC 7009 contract. |
| `LIFECYCLE-SIGNALS` | ✅ | GitHub App installation and webhook lifecycle can signal installation, permission, repository-selection, and revocation changes. |

## Native-readiness gaps and retirement

GitHub does not currently accept an external stable Agent principal as the
native actor for general API operations, nor does its Resource API directly
consume the Realmroot proof-bound Agent authority profile.

This adapter can be retired when GitHub can authenticate a stable external
Agent, authorize it for selected repositories and operations, record it as the
native actor, and enforce revocation directly at the GitHub API boundary.

Current retirement blockers: `ACTOR-NATIVE`, `AGENT-DISPLAY`, and every
applicable `🟨` capability above. Adapter completion does not convert a `🟨`
capability into provider-native `✅`.
