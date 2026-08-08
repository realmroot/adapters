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

  @journey:github-provider-revocation @entrypoint:http
  Scenario: Realmroot disconnects a GitHub Provider connection
    Given Realmroot signs a revocation request for the connected broker reference
    When the adapter accepts that one-use request
    Then the broker reference and its installation contexts become unusable
    And replaying the signed revocation request is rejected

  @journey:github-permission-translation @entrypoint:http
  Scenario: GitHub App permissions are exposed as Realmroot scopes
    Given the GitHub App installation grants metadata read and issues write
    When Realmroot completes the Provider connection
    Then the connection grants metadata:read, issues:read, and issues:write
    And provider permissions are absent from authorization details
    And authorization details only identify the selected GitHub installation

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
