# Security Policy

Realmroot Adapters handles delegated authority and external-platform
credentials. Treat suspected identity, authorization, credential, audit, DPoP,
or isolation failures as security issues.

## Reporting a vulnerability

Do not open a public issue.

Use GitHub's private vulnerability reporting for this repository:

<https://github.com/realmroot/adapters/security/advisories/new>

Include, when possible:

- affected provider and version or commit;
- prerequisites and provider account type;
- reproduction steps or a minimal proof of concept;
- expected and observed authorization behavior;
- potential Agent, Resource, credential, or tenant impact;
- whether provider-visible audit or identity records are incorrect;
- suggested mitigations.

Do not include live credentials, refresh tokens, private keys, customer data, or
personal data. Revoke any credential that may have been exposed during
research.

We will acknowledge a report as soon as practical, coordinate validation and a
fix privately, and credit reporters who want attribution after remediation.

## Supported versions

The project is not yet production-ready and has no supported release line. This
section will be updated before the first stable release.

## Security invariants

- Agent-facing requests require DPoP.
- Provider credentials never cross the Agent boundary.
- Provider actors derive from authenticated Realmroot principals and connected
  account state.
- Resource and scope decisions fail closed.
- Revoked or reduced provider authority stops future access.
- Audit events never contain credentials or sensitive request bodies.
