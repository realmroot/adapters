Feature: Cloudflare OAuth REST adapter
  Realmroot Agents use the Adapter as a standard external authorization server without receiving Cloudflare credentials.

  @journey:cloudflare-contract @entrypoint:http
  Scenario: Realmroot discovers the fail-closed Cloudflare REST contract
    Given the adapter pins an official Cloudflare OpenAPI commit and authenticated OAuth scope catalog
    When Realmroot reads the Cloudflare protected-resource metadata and service description
    Then every published operation declares at least one catalog-backed OAuth scope
    And every operation without provable OAuth authority is explicitly excluded
    And no unmatched path is forwarded

  @journey:cloudflare-token-exchange @entrypoint:http
  Scenario: The Adapter issues an external proof-bound Agent token
    Given the controller authorizes Cloudflare through the Adapter OAuth server
    And Cloudflare consent selects the accounts available to its provider credential
    When the Agent invokes a published Cloudflare operation
    Then Realmroot exchanges subject and actor tokens with the Adapter through RFC 8693
    And the Adapter issues the final DPoP token without Realmroot re-signing it
    And the Adapter token and stored Cloudflare credential scopes must authorize the operation
    And account and zone identifiers remain ordinary Cloudflare API parameters

  @journey:cloudflare-transparent-rest @entrypoint:http
  Scenario: An authorized operation is transparently forwarded to Cloudflare
    Given the Agent and Provider grants satisfy one published scope alternative
    When the Agent sends a Cloudflare REST request through the Adapter
    Then the method, path, query, body, conditional headers, idempotency key, and content type are preserved
    And inbound credentials, cookies, forwarding headers, and hop-by-hop headers are removed
    And the upstream origin is fixed to the Cloudflare v4 API
    And the status, body, ETag, pagination, rate-limit, and CF-Ray response data are preserved
    And no write request is automatically retried

  @journey:cloudflare-native-tool-discovery @entrypoint:http
  Scenario: Cloudflare advertises Wrangler execution
    When the Agent reads the Cloudflare Resource representation
    Then it advertises a Wrangler integration with its supported executable names
    And the integration identifies the local API-base broker protocol it requires
    And Wrangler-required Cloudflare routes missing from the official schema are explicitly pinned and scoped
    And Wrangler can inspect, deploy, and delete a Worker through the broker

  @journey:cloudflare-native-tool-scope-challenge @entrypoint:http
  Scenario: Cloudflare reports the authority required by a rejected native request
    Given a Wrangler request reaches a published Cloudflare operation
    And the selected Agent credential satisfies none of its scope alternatives
    When the adapter rejects the request before Cloudflare forwarding
    Then the insufficient-scope challenge advertises every operation scope alternative

  @journey:cloudflare-wrangler-token-verification @entrypoint:http
  Scenario: Wrangler verifies its process-local credential before an operation
    Given the Agent has at least one approved Cloudflare scope
    When Wrangler calls the Cloudflare token verification endpoint through the adapter
    Then the adapter authenticates the Agent proof-bound credential
    And returns a Wrangler-compatible active credential response without exposing the Provider credential
    And Wrangler can resolve the Agent-facing user and approved Cloudflare accounts without a personal API token
    And personal membership roles are omitted because the command runs as the Agent rather than the controller

  @journey:cloudflare-audit-privacy @entrypoint:http
  Scenario: Cloudflare transport audit excludes credentials and business payloads
    When a Cloudflare operation completes
    Then the audit records the Agent, operation ID, path template, selected scope, status, request ID, CF-Ray, and duration
    But it does not record tokens, authorization headers, query values, or body content
