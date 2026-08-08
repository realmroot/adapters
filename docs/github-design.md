# GitHub adapter design

The GitHub adapter is a protocol, credential, and attribution shim, not a
second GitHub API. It exposes a deliberately small slice of GitHub's REST shape
and forwards accepted operations to GitHub.

## Resource and connection boundaries

The Worker exposes one GitHub Resource Server:

```text
http://127.0.0.1:4103/github
```

One Realmroot owner has at most one Provider Connection for the GitHub
Connector. The adapter resolves that connection from the verified owner `sub`
and retains a stable opaque `broker_reference` across same-account
reauthorization. The Connection may contain any number of GitHub App installations. Installations
are concrete RFC 9396-style `github_installation` authorization details, not
URLs supplied by the caller:

```json
{
  "type": "github_installation",
  "installation_id": "152097080",
  "account_login": "saltbo",
  "target_type": "User"
}
```

Realmroot signs the Resource Authorization ID and approved authorization
details into each short-lived token. The Worker resolves the one GitHub binding
from the verified owner and intersects its installations with those signed
authorization details. A caller cannot select or substitute an installation
through a path parameter.

## Account connection

The Resource Server advertises the draft broker endpoints in its RFC 9728
metadata. Realmroot sends a signed, ten-minute request object containing the
owner, canonical Connection ID, callback URI, PKCE challenge, requested scopes,
and authorization-detail templates.

The Worker then:

1. authorizes the user with the GitHub App's OAuth client;
2. verifies the GitHub user and App installations visible to that user;
3. sends users with no installation through the GitHub App setup URL and
   verifies the installation after returning;
4. binds all verified installations to the owner's one active GitHub binding in D1; and
5. returns a one-use authorization code to Realmroot's callback.

The code exchange is PKCE-bound. Realmroot stores the Connection, subject hint,
scopes, and concrete installation contexts. GitHub user tokens and installation
credentials remain inside the Worker boundary. Reconnecting the same GitHub
subject updates the existing binding without changing its broker reference; a
different subject is rejected until the current Connection is revoked.

Realmroot disconnects the Provider Connection by posting a short-lived signed
request to the advertised revocation endpoint. The Worker validates the exact
issuer and Resource audience, consumes the request `jti` once, revokes the
matching broker reference, and deletes its installation contexts before
returning `204`.

## Runtime ownership

The shared runtime owns RFC 9728 and RFC 8631 discovery, Realmroot token and
DPoP validation, scope enforcement, idempotency, attribution, Problem Details,
request correlation, and audit records.

The runtime is an independent Cloudflare Worker. It reads provider credentials
from Worker secrets and owns a dedicated D1 database for account bindings,
installation contexts, one-time broker intents, DPoP replay claims, idempotent
response records, and audit events. Production code uses Web Crypto, Fetch, and
Cloudflare bindings; it has no Node server or filesystem dependency.

The GitHub provider owns GitHub App OAuth, App JWTs, installation-token
downscoping, installation and repository discovery, permission mapping, and
outbound HTTP translation. It accepts both GitHub-downloaded PKCS#1 private
keys and unencrypted PKCS#8 keys. Provider credentials and SDK types are never
exposed across either protocol boundary.

## Initial operation slice

| Adapter operation | GitHub operation | Realmroot scope |
| --- | --- | --- |
| `GET /repositories` | `GET /installation/repositories` for every token-bound installation | `github:metadata:read` |
| `POST /repos/{owner}/{repo}/issues` | Same path after resolving its bound installation | `github:issues:write` |

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
comment derived from the verified `act` claim and Realmroot public Agent Profile. The visible Agent link points to the
human-readable profile page, while the adapter resolves the machine-readable profile resource for verification.
Caller-supplied reserved markers are rejected.

This yields an explicit chain:

```text
Realmroot Agent -> GitHub App installation actor -> GitHub resource
```

The footer is display attribution, not a claim that GitHub natively
authenticated the Realmroot Agent.
