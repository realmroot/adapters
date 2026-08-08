Feature: GitHub App adapter
  Realmroot Agents use a GitHub App installation without receiving its credentials.

  @journey:worker-runtime @entrypoint:http
  Scenario: The adapter runs as an independent Cloudflare Worker
    Given the Worker has its own D1 binding and provider secrets
    When an Agent request reaches the Worker
    Then no Node server or filesystem is required
    And DPoP replay, idempotency, and audit state are durably stored in D1

  @journey:github-contract @entrypoint:http
  Scenario: Realmroot registers one GitHub App installation as a native Resource Server
    Given the adapter is configured to trust a Realmroot issuer
    When Realmroot discovers the installation Resource URL
    Then RFC 9728 metadata advertises the exact Resource and supported scopes
    And the metadata advertises authorization, credential, and revocation endpoints
    And the Resource advertises its OpenAPI contract with a service-desc link

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

  @journey:github-repositories @entrypoint:http
  Scenario: An authorized Agent lists repositories in one installation
    Given the Agent presents a Realmroot DPoP access token for that installation
    When the Agent lists repositories
    Then query parameters do not change the DPoP target URI
    And the adapter mints a short-lived GitHub installation credential
    And only repositories selected for that installation are returned
    And the GitHub credential is never returned

  @journey:github-create-issue @entrypoint:http
  Scenario: An authorized Agent creates an attributed issue
    Given the Agent has github:issues:write for that installation
    And the selected repository belongs to the installation
    When the Agent creates an issue with an idempotency key
    Then the adapter downscopes the GitHub credential to that repository and permission
    And GitHub records the GitHub App as its native actor
    And the issue body identifies the originating Realmroot Agent
    And a repeated request with the same key returns the original result

  @journey:github-reserved-attribution @entrypoint:http
  Scenario: An Agent cannot forge attribution
    Given the Agent has github:issues:write
    When the issue body contains a Realmroot attribution marker
    Then the adapter rejects the request before calling GitHub
