import { z } from 'zod'
import type { ConfiguredManagedProvider } from '../../core/configured-managed-provider.js'
import { search1ApiOpenApi } from './openapi.js'

const identitySchema = z
  .object({
    sub: z.string().min(1),
    name: z.string().min(1).optional(),
    preferred_username: z.string().min(1).optional(),
    email: z.email().optional(),
  })
  .passthrough()

const scope = 'search:read'

export const search1ApiDefinition = {
  id: 'search1api',
  name: 'Search1API',
  clientName: 'Realmroot Search1API Adapter',
  upstreamOrigin: 'https://api.search1api.com',
  endpoints: {
    authorization: 'https://clerk.s1.dev/oauth/authorize',
    registration: 'https://clerk.s1.dev/oauth/register',
    token: 'https://clerk.s1.dev/oauth/token',
    userInfo: 'https://clerk.s1.dev/oauth/userinfo',
    revocation: 'https://clerk.s1.dev/oauth/token/revoke',
  },
  providerScopes: ['openid', 'profile', 'email', 'offline_access'],
  agentScopes: { [scope]: 'Search the web and news, and inspect Search1API usage.' },
  operations: [
    { operationId: 'createWebSearch', method: 'POST', path: '/searches', upstreamPath: '/search', scopes: [scope] },
    {
      operationId: 'createNewsSearch',
      method: 'POST',
      path: '/news-searches',
      upstreamPath: '/news',
      scopes: [scope],
    },
    { operationId: 'getSearchUsage', method: 'GET', path: '/usage', upstreamPath: '/usage', scopes: [scope] },
  ],
  identity(value) {
    const identity = identitySchema.parse(value)
    return {
      subject: identity.sub,
      displayName: identity.name ?? identity.preferred_username ?? identity.email ?? identity.sub,
    }
  },
  openapi: search1ApiOpenApi,
  manifest: {
    resourceTypes: ['web-search', 'news-search', 'usage'],
    revocationSignals: ['adapter-oauth-revocation', 'search1api-oauth-revocation'],
    nativeReadinessGaps: ['ACTOR-NATIVE', 'AGENT-DISPLAY', 'DPOP'],
    retirementCondition: 'Search1API accepts Realmroot Agent identity and proof-bound delegated authority directly.',
  },
} satisfies ConfiguredManagedProvider
