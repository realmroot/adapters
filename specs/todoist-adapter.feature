Feature: Todoist managed OpenAPI adapter

  Scenario: Todoist provider OAuth
    Given Todoist supports dynamic public-client registration
    When the adapter starts an authorization code flow
    Then it uses PKCE and requests only read-only provider scopes
    And encrypted credentials are stored per provider subject

  Scenario: Todoist contract
    Given the Todoist adapter is enabled
    When an Agent discovers the Resource Server
    Then the OpenAPI document publishes project and task collections
    And every operation requires the tasks:read scope

  Scenario: Todoist project discovery
    Given an Agent has approved tasks:read access
    When it lists Todoist projects
    Then the adapter forwards the request with the delegated Todoist credential

  Scenario: Todoist task discovery
    Given an Agent has approved tasks:read access
    When it lists Todoist tasks with optional collection filters
    Then the adapter forwards only the published query operation
