Feature: Linear Agent adapter
  Realmroot Agents use Linear's native App actor through one Provider Connection.

  @journey:linear-contract @entrypoint:http
  Scenario: Linear publishes one Agent-facing Resource Server
    Given the Linear adapter trusts a Realmroot issuer
    When a client discovers the Linear Resource Server
    Then it advertises RFC 9728 metadata and an OpenAPI service description
    And it exposes Linear's official OAuth scopes without a provider prefix
    And the service description exposes each official scope as a selectable security alternative
    And it identifies the provider boundary as a shared native App actor with per-operation Agent attribution

  @journey:linear-provider-connection @entrypoint:http
  Scenario: One Provider Connection identifies the user and installs the App
    Given a Realmroot owner starts one Linear Provider connection
    When the owner authorizes their Linear user and then installs the App with actor app
    Then the adapter binds the stable Linear user to that one Provider Connection
    And it stores the installed workspace as a connection context
    And provider credentials remain encrypted outside Realmroot and the Agent

  @journey:linear-workspace-reauthorization @entrypoint:http
  Scenario: Reauthorization adds or refreshes workspace contexts without duplicating the connection
    Given a Realmroot owner already has one Linear Provider Connection
    When the same Linear user authorizes another workspace or refreshes an existing workspace
    Then the adapter preserves the existing broker reference
    And it keeps one active workspace context per Linear workspace
    And a different Linear user cannot replace the active connection

  @journey:linear-transparent-graphql @entrypoint:http
  Scenario: An authorized Agent calls the original Linear GraphQL API
    Given the Agent token selects one connected Linear workspace
    And the token contains the official Linear scopes required by the selected GraphQL operation
    When the Agent posts the original GraphQL document and variables through the adapter
    Then the adapter forwards the GraphQL transport to Linear without inventing REST business endpoints
    And it preserves Linear's response status, headers, body, partial data, and errors
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
  Scenario: Linear permission and revocation webhooks invalidate local authority
    Given Linear signs a fresh webhook delivery for an installed workspace
    When team access changes or the OAuth App is revoked
    Then the adapter verifies the raw body signature, timestamp, OAuth client, and delivery identity
    And it updates or revokes only the matching Linear workspace context
    And a replayed webhook delivery is rejected without repeating the transition

  @journey:linear-provider-isolation @entrypoint:architecture
  Scenario: Linear remains independent from every other Provider implementation
    Given Linear owns its routes, connection tables, credential lifecycle, scope evaluation, and transformations
    When Linear is added or repaired
    Then no other Provider implementation needs to change
    And Linear does not import another Provider implementation
