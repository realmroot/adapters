Feature: Linear Agent adapter
  Realmroot Agents use Linear's native App actor through Realmroot-managed Provider Connections.

  @journey:linear-contract @entrypoint:http
  Scenario: Linear publishes one Agent-facing Resource Server
    Given the Linear adapter trusts a Realmroot issuer
    When a client discovers the Linear Resource Server
    Then it advertises RFC 9728 metadata and an OpenAPI service description
    And it exposes Linear's official OAuth scopes without a provider prefix
    And the service description exposes each official scope as a selectable security alternative
    And it identifies the provider boundary as a managed native App actor with per-operation Agent attribution

  @journey:linear-provider-connection @entrypoint:http
  Scenario: Realmroot manages one Provider Connection per workspace
    Given a Realmroot owner starts a Linear Provider Connection
    When Realmroot authorizes the workspace with actor app and prompt consent
    Then Realmroot identifies the connection by the Linear organization
    And Realmroot stores the workspace credential independently from authentication accounts
    And the adapter stores no Linear credentials or connection state

  @journey:linear-workspace-reauthorization @entrypoint:http
  Scenario: Reauthorization adds or refreshes workspace connections without duplication
    Given a Realmroot owner already has one Linear workspace Provider Connection
    When the owner authorizes another workspace or refreshes the existing workspace
    Then Realmroot creates one connection per distinct organization identifier
    And reauthorization replaces only the matching workspace credential

  @journey:linear-transparent-graphql @entrypoint:http
  Scenario: An authorized Agent calls the original Linear GraphQL API
    Given the Agent token binds one managed Linear workspace connection
    And the token contains the official Linear scopes required by the selected GraphQL operation
    When the Agent posts the original GraphQL document and variables through the adapter
    Then the adapter forwards the GraphQL transport to Linear without inventing REST business endpoints
    And it preserves Linear's response status, headers, body, partial data, and errors
    And the adapter obtains the Linear credential through Realmroot token exchange
    And the Linear credential is never returned to the Agent

  @journey:linear-operation-scope @entrypoint:http
  Scenario: GraphQL operations are constrained by their official Linear scopes
    Given a Linear GraphQL request contains one selected operation
    When the adapter evaluates that operation before forwarding it
    Then queries require read or the provider's more specific read scope
    And issue and comment creation accept their targeted create scope or write
    And other mutations require write or the provider's documented specialized write scope
    And an operation outside the Agent token scopes is rejected before Linear receives it

  @journey:linear-agent-display @entrypoint:http
  Scenario: Supported create mutations use trusted Agent display identity
    Given an authenticated Realmroot Agent creates a Linear issue or comment
    When the adapter transforms that selected GraphQL mutation
    Then it derives createAsUser and displayIconUrl from the verified Realmroot Agent Profile
    And it rejects Agent-supplied values for those reserved identity fields
    And Linear renders the Agent through its native application attribution without a content footer

  @journey:linear-provider-lifecycle @entrypoint:http
  Scenario: Realmroot owns Linear credential refresh and revocation
    Given a managed Linear workspace Provider Connection exists
    When its access token expires or the controller revokes the connection
    Then Realmroot refreshes or revokes the provider credential
    And the adapter remains stateless

  @journey:linear-provider-isolation @entrypoint:architecture
  Scenario: Linear remains independent from every other Provider implementation
    Given Linear owns its routes, scope evaluation, and transformations
    When Linear is added or repaired
    Then no other Provider implementation needs to change
    And Linear does not import another Provider implementation
