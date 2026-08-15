# GitHub adapter design

The GitHub adapter is a protocol, credential, and attribution shim, not a
second GitHub API. Under the `/github` Resource URL it mirrors GitHub's REST
paths and forwards them to `api.github.com`.

## Resource and connection boundaries

The Worker exposes one GitHub Resource Server:

```text
https://adapters.realmroot.dev/github
```

One Realmroot owner has one GitHub Provider Connection. That connection may
contain multiple GitHub App installations. An access token selects exactly one
installation through resource-oriented authorization details:

```json
{
  "type": "https://adapters.realmroot.dev/authorization-details/github-installation",
  "installation_id": "12345678",
  "account_login": "saltbo",
  "target_type": "User"
}
```

Authorization details identify resources only. They never carry GitHub
permissions.

The authorization-detail type uses the Adapter's stable URI namespace because
the Adapter defines and enforces this RFC 9396 extension. GitHub does not define
the type, so the identifier must not use a GitHub-owned domain.

The Adapter also advertises its authorization-detail catalog from OAuth
metadata. The catalog returns the opaque detail above together with a separate
human-facing display value: the GitHub account login is the Context label and
the installation ID remains stable metadata. Realmroot and Toolbox never use
the display label as authorization input.

## Installation permission upgrades

GitHub does not return permission-update acceptance to the App's Setup URL.
The Setup URL remains responsible for new installations and repository-access
changes, but it is not the completion signal for a newly added App permission.

When an existing installation lacks a newly requested permission, the Adapter
keeps the original OAuth intent and opens the exact installation review URL at
`/settings/installations/{installation_id}/permissions/update`. An
Adapter-owned waiting page polls the preserved transaction while GitHub opens
the review in a separate window. The signed `installation` webhook with action
`new_permissions_accepted` updates Adapter-owned authority. Only after that
target installation covers every requested scope does the Adapter complete the
same OAuth transaction, close the GitHub window, and return the controller to
Realmroot automatically.

Incomplete permission upgrades are not persisted as connected authority and do
not surface an intermediate Adapter error page during the normal approval
flow.

## Permission translation

The adapter reads the permissions configured on the GitHub App and exposes
them directly as Realmroot scopes. It does not add a `github:` namespace because
GitHub has its own Resource Server.

```text
GitHub metadata=read  -> metadata:read
GitHub issues=write   -> issues:read, issues:write
```

For each Agent request, the adapter authorizes the published operation against
the approved scopes before minting a short-lived GitHub installation access
token. That internal credential uses the selected installation's approved
permissions rather than repeating Agent authorization through per-operation
permission narrowing. A `/repos/{owner}/{repo}/...` path additionally limits
the credential to the named repository. GitHub remains responsible for its own
provider permission enforcement and returns its original `403` response when
the installation lacks authority.

## Transparent proxy

After DPoP authentication and operation authorization, the adapter preserves the
original HTTP method, GitHub path, query string, request body, response status,
and response headers. It removes the Realmroot authorization and DPoP headers
before injecting the short-lived installation credential. Provider credentials
are never returned to the caller.

For example:

```text
GET  /github/installation/repositories
  -> https://api.github.com/installation/repositories

POST /github/repos/realmroot/adapters/issues
  -> https://api.github.com/repos/realmroot/adapters/issues
```

This means adding GitHub REST coverage normally requires no adapter code. App
permission configuration and Realmroot scope approval control what Agents can
use.

The service description starts from GitHub's complete official OpenAPI, keeps
only operations documented for installation access tokens, and adds the exact
GitHub App permission scope to each operation. It publishes one self-contained
document with the adapter server and Realmroot security boundary, so clients do
not depend on cross-origin references. `npm run sync:github-openapi` refreshes
the generated operation and permission catalog from GitHub's own documentation;
operations are never hand-maintained in adapter code.

## Compatibility transformations

Only operations that need behavior GitHub cannot provide enter a GitHub-owned
transformer registry. Issue creation and selected comment writes append a
visible Realmroot Agent footer and a machine-readable attribution marker. All
other operations remain streamed and unparsed.

Caller-supplied attribution markers are rejected. The visible Agent data comes
from the verified Realmroot Agent Profile, never from request content.

## Provider isolation

GitHub owns its routes, OAuth and installation connection, D1 repository,
permission translation, credential client, transparent proxy, manifest,
OpenAPI description, and transformers under `src/providers/github`. Shared
code knows only the `AdapterModule` registration contract and the generic
Realmroot security boundary. An architecture test rejects imports from one
provider implementation into another.
