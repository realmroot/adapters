Feature: Cloudflare OAuth REST adapter
  Realmroot Agents use a controller-authorized Cloudflare OAuth connection without receiving provider credentials.

  @journey:cloudflare-contract @entrypoint:http
  Scenario: Realmroot discovers the fail-closed Cloudflare REST contract
    Given the adapter pins an official Cloudflare OpenAPI commit and authenticated OAuth scope catalog
    When Realmroot reads the Cloudflare protected-resource metadata and service description
    Then every published operation declares at least one catalog-backed OAuth scope
    And every operation without provable OAuth authority is explicitly excluded
    And no unmatched path is forwarded

  @journey:cloudflare-token-exchange @entrypoint:http
  Scenario: The Adapter obtains a request-local provider token from Realmroot
    Given an Agent presents a DPoP-bound Realmroot token for the Cloudflare Adapter
    And the token is bound to a Realmroot-custodied Provider Connection
    When the Agent invokes a published Cloudflare operation
    Then the Adapter exchanges the original Agent token through the standard Realmroot OAuth token endpoint
    And the Adapter Application and Agent and Provider scopes must all authorize the operation
    And the Cloudflare access token exists only in request memory

  @journey:cloudflare-transparent-rest @entrypoint:http
  Scenario: An authorized operation is transparently forwarded to Cloudflare
    Given the Agent and Provider grants satisfy one published scope alternative
    When the Agent sends a Cloudflare REST request through the Adapter
    Then the method, path, query, body, conditional headers, idempotency key, and content type are preserved
    And inbound credentials, cookies, forwarding headers, and hop-by-hop headers are removed
    And the upstream origin is fixed to the Cloudflare v4 API
    And the status, body, ETag, pagination, rate-limit, and CF-Ray response data are preserved
    And no write request is automatically retried

  @journey:cloudflare-audit-privacy @entrypoint:http
  Scenario: Cloudflare transport audit excludes credentials and business payloads
    When a Cloudflare operation completes
    Then the audit records the Agent, operation ID, path template, selected scope, status, request ID, CF-Ray, and duration
    But it does not record tokens, authorization headers, query values, or body content
