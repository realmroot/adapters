import { z } from 'zod'
import {
  createManagedOAuthExternalAuthorization,
  type ManagedOAuthClient,
  type ManagedOAuthCredentials,
} from '../../core/managed-oauth.js'

const identitySchema = z
  .object({
    id: z.union([z.string().min(1), z.number().int().positive()]),
    full_name: z.string().min(1).optional(),
    email: z.email().optional(),
  })
  .passthrough()

export const todoistAgentScope = 'tasks:read'
export const todoistProviderScopes = ['data:read'] as const

export function createTodoistExternalAuthorization(input: {
  origin: string
  provider: ManagedOAuthClient
  credentials: ManagedOAuthCredentials
}) {
  return createManagedOAuthExternalAuthorization({
    id: 'todoist',
    name: 'Todoist',
    origin: input.origin,
    agentScopes: [todoistAgentScope],
    provider: input.provider,
    credentials: input.credentials,
    identity(value) {
      const identity = identitySchema.parse(value)
      const subject = String(identity.id)
      return { subject, displayName: identity.full_name ?? identity.email ?? subject }
    },
  })
}
