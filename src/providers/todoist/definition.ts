import { z } from 'zod'
import type { ConfiguredManagedProvider } from '../../core/configured-managed-provider.js'
import { todoistOpenApi } from './openapi.js'

const identitySchema = z
  .object({
    id: z.union([z.string().min(1), z.number().int().positive()]),
    full_name: z.string().min(1).optional(),
    email: z.email().optional(),
  })
  .passthrough()

const scope = 'tasks:read'

export const todoistDefinition = {
  id: 'todoist',
  name: 'Todoist',
  clientName: 'Realmroot Todoist Adapter',
  upstreamOrigin: 'https://api.todoist.com/api/v1',
  endpoints: {
    authorization: 'https://app.todoist.com/oauth/authorize',
    registration: 'https://api.todoist.com/oauth/register',
    token: 'https://api.todoist.com/oauth/access_token',
    userInfo: 'https://api.todoist.com/api/v1/user',
  },
  providerScopes: ['data:read'],
  agentScopes: { [scope]: 'List active Todoist projects and tasks.' },
  operations: [
    {
      operationId: 'listTodoistProjects',
      method: 'GET',
      path: '/projects',
      upstreamPath: '/projects',
      scopes: [scope],
    },
    {
      operationId: 'listTodoistTasks',
      method: 'GET',
      path: '/tasks',
      upstreamPath: '/tasks',
      scopes: [scope],
    },
  ],
  authorizationScopeSeparator: ',',
  authorizationWrapper: {
    endpoint: 'https://app.todoist.com/users/showlogin',
    returnUrlParameter: 'success_page',
  },
  identity(value) {
    const identity = identitySchema.parse(value)
    const subject = String(identity.id)
    return { subject, displayName: identity.full_name ?? identity.email ?? subject }
  },
  openapi: todoistOpenApi,
  manifest: {
    resourceTypes: ['project', 'task'],
    revocationSignals: ['adapter-local-revocation'],
    nativeReadinessGaps: ['ACTOR-NATIVE', 'AGENT-DISPLAY', 'DPOP', 'PROVIDER-REVOCATION'],
    retirementCondition: 'Todoist accepts Realmroot Agent identity and proof-bound delegated authority directly.',
  },
} satisfies ConfiguredManagedProvider
