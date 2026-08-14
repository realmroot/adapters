Feature: GitHub App adapter
  Realmroot Agents use a GitHub App installation without receiving its credentials.

  @journey:worker-runtime @entrypoint:http
  Scenario: The adapter runs as an independent Cloudflare Worker
    Given the Worker has its own D1 binding and provider secrets
    When an Agent request reaches the Worker
    Then no Node server or filesystem is required
    And DPoP replay and audit state are durably stored in D1

  @journey:github-contract @entrypoint:http
  Scenario: Realmroot registers GitHub as an external Resource Server
    Given the adapter publishes its own OAuth issuer
    When Realmroot discovers the installation Resource URL
    Then RFC 9728 metadata advertises the exact Resource and supported scopes
    And the metadata advertises authorization, credential, and revocation endpoints
    And the Resource advertises GitHub's installation-token operations with a service-desc link
    And each operation declares its native GitHub App permission scope

  @journey:github-provider-connection @entrypoint:http
  Scenario: One Realmroot owner keeps one GitHub external authorization across reauthorization
    Given a Realmroot owner has authorized a GitHub account and its App installations
    When the same owner reauthorizes that GitHub account
    Then the adapter keeps one stable external subject for the owner
    And replaces the installation authorization details with the newly authorized set

  @journey:github-installation-permission-upgrade @entrypoint:http
  Scenario: Authorization resumes after a GitHub installation permission upgrade
    Given an existing GitHub App installation lacks a newly requested permission
    When the owner authorizes that permission through Realmroot
    Then the adapter preserves the original authorization transaction
    And redirects through GitHub's state-preserving App installation entry point
    And accepts only the target installation
    And resumes the same Realmroot authorization after GitHub returns
    And returns a declined permission update to Realmroot as an OAuth denial
    But it does not show an adapter insufficient-scope page

  @journey:github-context-catalog @entrypoint:http
  Scenario: GitHub describes installation Contexts without exposing credentials
    Given the Adapter holds an active GitHub external authorization
    When Realmroot reads the advertised authorization-detail catalog with the connected subject token
    Then the adapter returns each active installation with its account name, stable installation ID, account type, and repository selection
    And reports the exact scopes currently granted by each installation
    And the response uses the shared authorization-detail catalog representation
    And the authorization detail type is a stable URI owned by the Adapter
    But it does not expose installation credentials

  @journey:github-provider-revocation @entrypoint:http
  Scenario: Realmroot disconnects a GitHub Provider connection
    Given Realmroot holds an Adapter-issued refresh token for the Provider connection
    When Realmroot sends that token to the Adapter's OAuth revocation endpoint
    Then the refresh token and its installation authority become unusable
    And repeating standard OAuth revocation does not restore authority

  @journey:github-installation-lifecycle @entrypoint:http
  Scenario: GitHub installation lifecycle changes immediately constrain connected authority
    Given a Realmroot owner has connected one or more GitHub App installations
    When GitHub reports an installation deletion, suspension, restoration, or permission change
    Then the adapter verifies the delivery signature before changing installation context
    And rejects an oversized delivery before signature verification
    And the adapter immediately removes, suspends, restores, or updates the affected installation context
    And older lifecycle state cannot replace newer provider state
    And equal-timestamp suspension, authority reduction, and deletion cannot be undone by an ambiguous expansion
    And subsequent token issuance and execution use the updated Adapter-owned authority

  @journey:github-installation-resources @entrypoint:http
  Scenario: GitHub installation repository changes invalidate affected grants
    Given a Realmroot owner has connected a GitHub App installation
    When GitHub reports repositories added to or removed from the installation
    Then the adapter updates its provider-private repository membership immediately
    And equal-timestamp removal wins for the same repository while independent repository changes merge
    And subsequent token issuance excludes removed repositories
    And replaying the same GitHub delivery does not apply the event twice

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
    And slash-delimited Git reference names resolve to their documented operation

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

  @journey:github-native-tool-discovery @entrypoint:http
  Scenario: GitHub advertises supported native tools
    When the Agent reads the GitHub Resource representation
    Then it advertises Git and GitHub CLI integrations with their supported executable names
    And each integration identifies the local broker protocol it requires

  @journey:github-native-tool-scope-challenge @entrypoint:http
  Scenario: GitHub reports the authority required by a rejected native request
    Given a native GitHub request reaches a published operation
    And the selected Agent credential does not satisfy its permission requirements
    When the adapter rejects the request before calling GitHub
    Then the insufficient-scope challenge advertises each available permission alternative
    And it does not expose unavailable GitHub App permissions

  @journey:github-graphql-proxy @entrypoint:http
  Scenario: GitHub CLI sends GraphQL through approved Agent authority
    Given the Agent has an approved GitHub installation authority
    When GitHub CLI sends a GraphQL request through the adapter
    Then the adapter mints an installation credential constrained to the approved scopes
    And the GraphQL request and response are preserved
    And unsupported createPullRequest, addComment, and mergePullRequest mutations use GitHub's installation-compatible REST operations
    And the GitHub credential is never returned

  @journey:github-git-transport @entrypoint:http
  Scenario: Native Git uses the GitHub installation through the adapter
    Given the Agent has approved repository contents authority
    When Git performs Smart HTTP discovery, fetch, or push through the adapter
    Then the adapter constrains the installation credential to that repository
    And read transport requires contents read
    And write transport requires contents write and workflows write because the adapter cannot inspect the complete Git pack before forwarding it
    And the GitHub credential is never returned

  @journey:github-attributed-content @entrypoint:http
  Scenario: An authorized Agent writes attributed GitHub content
    Given the Agent has write authority for the selected GitHub installation
    And the selected repository belongs to the installation
    When the Agent writes user-visible GitHub content through any supported interface
    Then the adapter downscopes the GitHub credential to that repository and the requested permissions
    And GitHub records the GitHub App as its native actor
    And every written body identifies the originating Realmroot Agent
    And the original GitHub response is returned unchanged

  @journey:github-reserved-attribution @entrypoint:http
  Scenario: An Agent cannot forge attribution
    Given the Agent has GitHub write authority
    When a written body contains a Realmroot attribution marker
    Then the adapter rejects the request before calling GitHub

  @journey:provider-isolation @entrypoint:architecture
  Scenario: Provider adapters remain independently maintainable
    Given each Provider implementation owns its routes, storage, permission translation, and transformations
    When a new Provider adapter is added or an existing Provider is repaired
    Then no other Provider implementation needs to change
    And Provider implementations cannot import one another
