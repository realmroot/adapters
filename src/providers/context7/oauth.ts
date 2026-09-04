import { z } from 'zod'
import type { ExternalProviderAuthorization } from '../../core/external-authorization-server.js'
import {
  createManagedOAuthExternalAuthorization,
  type ManagedOAuthClient,
  type ManagedOAuthCredentials,
} from '../../core/managed-oauth.js'

const identitySchema = z
  .object({
    sub: z.string().min(1),
    name: z.string().min(1).optional(),
    preferred_username: z.string().min(1).optional(),
    email: z.string().email().optional(),
  })
  .passthrough()

export const context7AgentScope = 'documentation:read'
export const context7ProviderScopes = ['openid', 'profile', 'email', 'offline_access'] as const

export type Context7OAuthClient = ManagedOAuthClient

export function createContext7ExternalAuthorization(input: {
  origin: string
  provider: Context7OAuthClient
  credentials: ManagedOAuthCredentials
}): ExternalProviderAuthorization {
  return createManagedOAuthExternalAuthorization({
    id: 'context7',
    name: 'Context7',
    origin: input.origin,
    agentScopes: [context7AgentScope],
    providerScopes: context7ProviderScopes,
    provider: input.provider,
    credentials: input.credentials,
    identity(value) {
      const identity = identitySchema.parse(value)
      return {
        subject: identity.sub,
        displayName: identity.name ?? identity.preferred_username ?? identity.email ?? identity.sub,
      }
    },
  })
}
