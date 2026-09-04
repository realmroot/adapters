Feature: Context7 managed OpenAPI adapter
  Realmroot Agents query Context7 through a reusable authenticated OpenAPI boundary.

  @journey:context7-contract @entrypoint:http
  Scenario: Realmroot discovers the Context7 Resource Server
    Given Context7 is configured as a managed OpenAPI adapter
    When Realmroot reads its protected-resource metadata and service description
    Then both published operations require the documentation:read scope
    And no operation outside the configured allowlist is forwarded

  @journey:context7-provider-oauth @entrypoint:http
  Scenario: The controller connects Context7 without provisioned client credentials
    Given Context7 supports OAuth dynamic client registration
    When the controller begins the Adapter authorization flow
    Then the Adapter registers a public OAuth client once and uses S256 PKCE
    And the PKCE verifier and resulting Context7 tokens are encrypted at rest

  @journey:context7-library-discovery @entrypoint:http
  Scenario: An Agent resolves a library before reading documentation
    Given the Agent has approved Context7 documentation access
    When it lists libraries by library name and task query
    Then the managed adapter forwards the request to the configured Context7 search operation
    And it returns Context7's ranked library resources unchanged

  @journey:context7-documentation @entrypoint:http
  Scenario: An Agent retrieves documentation for a resolved library
    Given the Agent selected a Context7 library identifier
    When it reads documentation using that identifier and a task query
    Then the managed adapter forwards the request to the configured Context7 context operation
    And it preserves the upstream content type, status, and body

  @journey:context7-audit-privacy @entrypoint:http
  Scenario: Context7 transport audit excludes credentials and query content
    When a published Context7 operation completes
    Then the audit records the Agent, operation ID, path template, selected scope, status, request ID, and duration
    But it does not record tokens, authorization headers, query values, or response content
