## Outcome

<!-- What observable provider or contributor outcome does this change deliver? -->

## Identity and authorization

<!-- Which actors, Resources, scopes, credentials, and revocation paths change? -->

## Verification

<!-- List exact automated checks and isolated provider acceptance steps. -->

## Provider evidence

<!-- Link official provider documentation for new or changed capability claims. -->

## Checklist

- [ ] I did not add credentials, customer data, or personal provider data.
- [ ] Identity fidelity is stated accurately and does not confuse display attribution with a security principal.
- [ ] Resource and scope behavior fails closed.
- [ ] Provider errors remain inside the adapter boundary.
- [ ] Documentation and the capability manifest are updated where applicable.
- [ ] Provider work documents native-readiness gaps and does not make the adapter harder to retire without justification.
- [ ] Tests prove the changed behavior at the cheapest meaningful layer.
- [ ] Commits include a Developer Certificate of Origin sign-off.
