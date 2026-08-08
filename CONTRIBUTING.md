# Contributing to Realmroot Adapters

Thank you for helping external platforms recognize and safely authorize
Realmroot Agents.

## Before you start

- Search existing issues and provider proposals.
- For a new provider, open a provider proposal before implementation.
- For security vulnerabilities, follow [SECURITY.md](SECURITY.md) instead of
  opening a public issue.
- Keep credentials, customer data, and personal provider accounts out of tests,
  fixtures, issues, and pull requests.

## Provider proposal

A proposal must document evidence from the provider's official contract or
documentation for:

1. native actor types and stable identifiers;
2. whether the actor is visible in product UI, audit logs, or both;
3. installation, authorization, and administrator requirements;
4. credential issuance, expiry, rotation, and revocation;
5. discoverable Resource types and selection boundaries;
6. permissions and their mapping to operations;
7. webhook or polling signals for permission and installation changes;
8. provider idempotency guarantees and remaining deduplication needs;
9. the smallest representative read and write operations;
10. known product-tier, review, marketplace, or compliance requirements.

A provider that only supports a shared application actor is still welcome, but
must declare `brokered` identity rather than presenting display attribution as
a native Agent principal.

## Development principles

- Start with one complete provider journey and its proof.
- Keep canonical contracts owned by the application behavior that consumes
  them; adapters implement those contracts.
- Do not expose provider SDK types, token formats, or HTTP response shapes to
  the core.
- Validate at Agent, provider, network, environment, and persistence
  boundaries. Do not add internal fallback behavior for impossible states.
- Fail closed on authorization uncertainty and revocation.
- Never downgrade DPoP to bearer authentication on the Agent-facing boundary.
- Never log or return provider credentials.
- Add dependencies only when they remove meaningful complexity.

## Pull requests

Pull requests should be focused and include:

- the observable behavior being added or changed;
- the identity and authorization semantics involved;
- tests at the cheapest layer that proves the behavior;
- provider documentation supporting any capability claim;
- security and revocation implications;
- manual review steps for an isolated provider test environment;
- updates to the provider README, capability manifest, and roadmap when
  applicable.

Maintainers may ask to split a provider contribution when identity,
authorization, discovery, and operation changes cannot be reviewed safely as
one unit.

## Commit messages

Use clear, imperative commits. Conventional Commit prefixes are encouraged:

```text
feat(linear): add app actor installation
fix(github): reject removed repositories
docs(cloudflare): document audit actor mapping
```

## Review expectations

Every material change is reviewed on two axes:

- **Outcome:** it provides the requested provider behavior without overstating
  identity fidelity.
- **Engineering:** it preserves security boundaries, failure semantics,
  observability, tests, compatibility, and maintainability.

## Developer Certificate of Origin

By contributing, you certify that you have the right to submit the work under
this project's Apache-2.0 license. Sign off each commit with:

```bash
git commit -s
```

The sign-off records the Developer Certificate of Origin statement available
at <https://developercertificate.org/>.
