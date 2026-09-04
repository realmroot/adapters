import type { AdapterModule } from '../../core/adapter.js'
import {
  createManagedOAuthCredentialSource,
  type ManagedOAuthClient,
  type ManagedOAuthCredentials,
} from '../../core/managed-oauth.js'
import { createManagedOpenApiAdapter } from '../../core/managed-openapi-adapter.js'
import type { RealmrootAuthenticator } from '../../core/realmroot-auth.js'
import type { TodoistAdapterConfig } from './config.js'
import { todoistAgentScope, todoistProviderScopes } from './oauth.js'
import { todoistOpenApi } from './openapi.js'

export function createTodoistAdapter(
  config: TodoistAdapterConfig,
  dependencies: {
    authenticator: RealmrootAuthenticator
    provider: ManagedOAuthClient
    credentials: ManagedOAuthCredentials
    audit(record: Record<string, unknown>): Promise<void>
    fetch?: typeof fetch
  },
): AdapterModule {
  const resource = `${config.origin}/todoist`
  const issuer = `${config.origin}/oauth/todoist`
  const operations = [
    {
      operationId: 'listTodoistProjects',
      method: 'GET',
      path: '/projects',
      upstreamPath: '/projects',
      scopes: [todoistAgentScope],
    },
    {
      operationId: 'listTodoistTasks',
      method: 'GET',
      path: '/tasks',
      upstreamPath: '/tasks',
      scopes: [todoistAgentScope],
    },
  ] as const

  return createManagedOpenApiAdapter(
    {
      id: 'todoist',
      resource,
      issuer,
      upstreamOrigin: config.todoistApiOrigin,
      scopes: { [todoistAgentScope]: 'List active Todoist projects and tasks.' },
      operations,
      openapi: todoistOpenApi({ resource, issuer }),
      representation: { upstream: 'todoist', operationMode: 'configured-openapi' },
      manifest: {
        schemaVersion: '0.1',
        provider: 'todoist',
        status: 'experimental',
        identity: {
          level: 'provider-delegated',
          visibleInProduct: false,
          visibleInAuditLog: false,
          attribution: 'audit-only',
        },
        actorModes: ['oauth-delegated-user'],
        credentialModes: ['adapter-dynamic-public-oauth'],
        resourceTypes: ['project', 'task'],
        scopes: { [todoistAgentScope]: { providerPermissions: { oauthScope: 'data:read' } } },
        operations,
        revocationSignals: ['adapter-local-revocation'],
        nativeReadinessGaps: ['ACTOR-NATIVE', 'AGENT-DISPLAY', 'DPOP', 'PROVIDER-REVOCATION'],
        retirementCondition: 'Todoist accepts Realmroot Agent identity and proof-bound delegated authority directly.',
      },
    },
    {
      authenticator: dependencies.authenticator,
      audit: dependencies.audit,
      ...(dependencies.fetch ? { fetch: dependencies.fetch } : {}),
      credential: createManagedOAuthCredentialSource({
        agentScopes: [todoistAgentScope],
        providerScopes: todoistProviderScopes,
        provider: dependencies.provider,
        credentials: dependencies.credentials,
      }),
    },
  )
}
