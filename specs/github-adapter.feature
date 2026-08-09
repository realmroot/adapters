Feature: GitHub App adapter
  Realmroot Agents use a GitHub App installation without receiving its credentials.

  @journey:worker-runtime @entrypoint:http
  Scenario: The adapter runs as an independent Cloudflare Worker
    Given the Worker has its own D1 binding and provider secrets
    When an Agent request reaches the Worker
    Then no Node server or filesystem is required
    And DPoP replay and audit state are durably stored in D1

  @journey:github-contract @entrypoint:http
  Scenario: Realmroot registers one GitHub App installation as a native Resource Server
    Given the adapter is configured to trust a Realmroot issuer
    When Realmroot discovers the installation Resource URL
    Then RFC 9728 metadata advertises the exact Resource and supported scopes
    And the metadata advertises authorization, credential, and revocation endpoints
    And the Resource advertises GitHub's installation-token operations with a service-desc link
    And each operation declares its native GitHub App permission scope

  @journey:github-provider-connection @entrypoint:http
  Scenario: One Realmroot owner keeps one GitHub Provider connection across reauthorization
    Given a Realmroot owner has connected a GitHub account and its App installations
    When the same owner reauthorizes that GitHub account
    Then the adapter keeps one stable broker reference for the owner
    And replaces the installation contexts with the newly authorized set

  @journey:github-lifecycle-migration @entrypoint:migration
  Scenario: Legacy GitHub connections do not gain unknown repository authority
    Given a GitHub connection predates retained repository selection and membership
    When the lifecycle migration is applied
    Then the legacy connection is revoked and its installation contexts are removed
    And a durable generic revoked event updates Realmroot before the adapter serves requests
    And the controller can reconnect it with freshly discovered repository authority

  @journey:github-provider-revocation @entrypoint:http
  Scenario: Realmroot disconnects a GitHub Provider connection
    Given Realmroot signs a revocation request for the connected broker reference
    When the adapter accepts that one-use request
    Then the broker reference and its installation contexts become unusable
    And replaying the signed revocation request is rejected

  @journey:github-installation-lifecycle @entrypoint:http
  Scenario: GitHub installation lifecycle changes immediately constrain connected authority
    Given a Realmroot owner has connected one or more GitHub App installations
    When GitHub reports an installation deletion, suspension, restoration, or permission change
    Then the adapter verifies the delivery signature before changing installation context
    And rejects an oversized delivery before signature verification
    And the adapter immediately removes, suspends, restores, or updates the affected installation context
    And older lifecycle state cannot replace newer provider state
    And equal-timestamp suspension, authority reduction, and deletion cannot be undone by an ambiguous expansion
    And each accepted context change receives a monotonically increasing connection revision
    And Realmroot receives the corresponding signed generic Connection Event with complete authority constraints

  @journey:github-installation-resources @entrypoint:http
  Scenario: GitHub installation repository changes invalidate affected grants
    Given a Realmroot owner has connected a GitHub App installation
    When GitHub reports repositories added to or removed from the installation
    Then the adapter updates its provider-private repository membership immediately
    And equal-timestamp removal wins for the same repository while independent repository changes merge
    And Realmroot receives a signed resources changed Connection Event with the complete remaining contexts and authority constraints
    And replaying the same GitHub delivery does not apply or emit the event twice

  @journey:github-permission-translation @entrypoint:http
  Scenario: GitHub App permissions are exposed as Realmroot scopes
    Given the GitHub App installation grants metadata read and issues write
    When Realmroot completes the Provider connection
    Then the connection grants metadata:read, issues:read, and issues:write
    And provider permissions are absent from authorization details
    And authorization details identify the selected GitHub installation and its repository selection

  @journey:github-operation-permissions @entrypoint:http
  Scenario: GitHub operation permissions preserve alternatives and conjunctions
    Given GitHub documents each installation operation as permission alternatives containing required conjunctions
    When Realmroot discovers the GitHub service description
    Then each alternative is advertised as a separate OpenAPI security requirement
    And every permission in one conjunction is advertised together
    And every scope uses GitHub's native permission name without a provider prefix

  @journey:github-operation-authority @entrypoint:http
  Scenario: The adapter mints the least-privileged credential for the requested operation
    Given an Agent token satisfies one or more permission alternatives for a GitHub REST operation
    When the Agent calls the original GitHub REST path through the adapter
    Then the adapter selects one least-privileged satisfied permission set for that method and path
    And the short-lived GitHub installation credential contains only that selected permission set
    And unrelated scopes in the Agent token are not minted into the GitHub credential

  @journey:github-workflow-file-authority @entrypoint:http
  Scenario: Workflow file writes require both GitHub permissions
    Given an Agent calls the GitHub repository contents endpoint
    When the target path is under .github/workflows
    Then the Agent must have contents:write and workflows:write
    And the short-lived GitHub installation credential requests both permissions
    But a write outside .github/workflows only requires contents:write

  @journey:github-transparent-proxy @entrypoint:http
  Scenario: An authorized Agent calls the original GitHub REST API
    Given the Agent presents a Realmroot DPoP access token for that installation
    And the token contains the GitHub permissions requested as Realmroot scopes
    When the Agent calls any GitHub REST path through the adapter
    Then query parameters do not change the DPoP target URI
    And the adapter translates the scopes into a short-lived GitHub installation credential
    And the adapter selects GitHub's API or upload origin for the original operation
    And the original method, path, query, body, status, and response headers are preserved
    And GitHub performs endpoint permission enforcement
    And the GitHub credential is never returned

  @journey:github-create-issue @entrypoint:http
  Scenario: An authorized Agent creates an attributed issue
    Given the Agent has issues:write for that installation
    And the selected repository belongs to the installation
    When the Agent calls GitHub's create issue endpoint
    Then the adapter downscopes the GitHub credential to that repository and the requested permissions
    And GitHub records the GitHub App as its native actor
    And the issue body identifies the originating Realmroot Agent
    And the original GitHub response is returned unchanged

  @journey:github-reserved-attribution @entrypoint:http
  Scenario: An Agent cannot forge attribution
    Given the Agent has issues:write
    When the issue body contains a Realmroot attribution marker
    Then the adapter rejects the request before calling GitHub

  @journey:provider-isolation @entrypoint:architecture
  Scenario: Provider adapters remain independently maintainable
    Given each Provider implementation owns its routes, storage, permission translation, and transformations
    When a new Provider adapter is added or an existing Provider is repaired
    Then no other Provider implementation needs to change
    And Provider implementations cannot import one another
