import { z } from 'zod'
import type { ConfiguredManagedProvider } from '../../core/configured-managed-provider.js'
import { fastioOpenApi } from './openapi.js'

const identitySchema = z
  .object({
    user: z.object({
      id: z.string().min(1),
      first_name: z.string().optional(),
      last_name: z.string().optional(),
      email_address: z.email().optional(),
    }),
  })
  .passthrough()

const scope = 'workspace:read'

export const fastioDefinition = {
  id: 'fastio',
  name: 'Fast.io',
  clientName: 'Realmroot Fast.io Adapter',
  upstreamOrigin: 'https://api.fast.io',
  endpoints: {
    authorization: 'https://go.fast.io/api/current/oauth/authorize',
    registration: 'https://go.fast.io/api/current/oauth/register',
    token: 'https://go.fast.io/api/current/oauth/token',
    userInfo: 'https://api.fast.io/current/user/details/',
    revocation: 'https://go.fast.io/api/current/oauth/revoke',
  },
  providerScopes: ['all_workspaces'],
  agentScopes: { [scope]: 'List accessible Fast.io workspaces and profile availability.' },
  operations: [
    {
      operationId: 'listFastioWorkspaces',
      method: 'GET',
      path: '/workspaces',
      upstreamPath: '/current/workspaces/all/',
      scopes: [scope],
    },
    {
      operationId: 'getFastioProfileAvailability',
      method: 'GET',
      path: '/profile-availability',
      upstreamPath: '/current/user/available_profiles/',
      scopes: [scope],
    },
  ],
  identity(value) {
    const { user } = identitySchema.parse(value)
    const displayName = [user.first_name, user.last_name].filter(Boolean).join(' ')
    return { subject: user.id, displayName: displayName || user.email_address || user.id }
  },
  openapi: fastioOpenApi,
  manifest: {
    resourceTypes: ['workspace', 'profile-availability'],
    revocationSignals: ['adapter-oauth-revocation', 'fastio-oauth-revocation'],
    nativeReadinessGaps: ['ACTOR-NATIVE', 'AGENT-DISPLAY', 'DPOP'],
    retirementCondition: 'Fast.io accepts Realmroot Agent identity and proof-bound delegated authority directly.',
  },
} satisfies ConfiguredManagedProvider
