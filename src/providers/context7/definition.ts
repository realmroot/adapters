import { z } from 'zod'
import type { ConfiguredManagedProvider } from '../../core/configured-managed-provider.js'
import { context7OpenApi } from './openapi.js'

const identitySchema = z
  .object({
    sub: z.string().min(1),
    name: z.string().min(1).optional(),
    preferred_username: z.string().min(1).optional(),
    email: z.email().optional(),
  })
  .passthrough()

const scope = 'documentation:read'

export const context7Definition = {
  id: 'context7',
  name: 'Context7',
  clientName: 'Realmroot Context7 Adapter',
  upstreamOrigin: 'https://context7.com/api',
  endpoints: {
    authorization: 'https://clerk.context7.com/oauth/authorize',
    registration: 'https://clerk.context7.com/oauth/register',
    token: 'https://clerk.context7.com/oauth/token',
    userInfo: 'https://clerk.context7.com/oauth/userinfo',
    revocation: 'https://clerk.context7.com/oauth/token/revoke',
  },
  providerScopes: ['openid', 'profile', 'email', 'offline_access'],
  agentScopes: { [scope]: 'Resolve libraries and read current software documentation.' },
  operations: [
    {
      operationId: 'listContext7Libraries',
      method: 'GET',
      path: '/libraries',
      upstreamPath: '/v2/libs/search',
      scopes: [scope],
    },
    {
      operationId: 'getContext7Documentation',
      method: 'GET',
      path: '/documentation',
      upstreamPath: '/v2/context',
      scopes: [scope],
    },
  ],
  identity(value) {
    const identity = identitySchema.parse(value)
    return {
      subject: identity.sub,
      displayName: identity.name ?? identity.preferred_username ?? identity.email ?? identity.sub,
    }
  },
  openapi: context7OpenApi,
  manifest: {
    resourceTypes: ['library', 'documentation'],
    revocationSignals: ['adapter-oauth-revocation', 'context7-oauth-revocation'],
    nativeReadinessGaps: ['ACTOR-NATIVE', 'AGENT-DISPLAY', 'DPOP'],
    retirementCondition: 'Context7 accepts Realmroot Agent identity and proof-bound delegated authority directly.',
  },
} satisfies ConfiguredManagedProvider
