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
