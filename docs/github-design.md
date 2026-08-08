# GitHub adapter design

The GitHub adapter is a protocol and credential shim, not a second GitHub API.
It exposes a deliberately small, generated-compatible slice of GitHub's REST
shape and forwards accepted operations to GitHub.

## Resource boundary

One GitHub App installation is one Realmroot native Resource Server:

```text
http://127.0.0.1:4103/github/installations/{installationId}
```

The installation identifier is therefore part of the OAuth audience. A token
issued for one installation cannot be replayed against another installation.
Repository-level authorization is enforced again before each forwarded call.

## Runtime ownership

The shared runtime owns RFC 9728 and RFC 8631 discovery, Realmroot token and
DPoP validation, scope enforcement, idempotency, attribution, Problem Details,
request correlation, and audit records.

The GitHub provider owns GitHub App JWTs, installation-token downscoping,
installation and repository discovery, GitHub permission mapping, and outbound
HTTP translation. It does not expose provider credentials or SDK types.

## Initial operation slice

| Adapter operation | GitHub operation | Realmroot scope |
| --- | --- | --- |
| `GET /repositories` | `GET /installation/repositories` | `github:metadata:read` |
| `POST /repos/{owner}/{repo}/issues` | Same path | `github:issues:write` |

The public OpenAPI document contains only this allowlist. Adding an operation
extends the allowlist and permission mapping; it does not add a second business
implementation.

The machine-readable provider manifest is available at
`/providers/github/manifest`. It declares identity fidelity, credential mode,
scope mappings, supported operations, revocation signals, native-readiness
gaps, and the adapter retirement condition.

## Attribution

GitHub displays the GitHub App bot as the native actor. For body-bearing writes,
the adapter appends a visible Realmroot Agent footer and a machine-readable HTML
comment derived from the verified `act` claim and AgentInfo. Caller-supplied
reserved markers are rejected.

This yields an explicit chain:

```text
Realmroot Agent -> GitHub App installation actor -> GitHub resource
```

The footer is display attribution, not a claim that GitHub natively authenticated
the Realmroot Agent.
