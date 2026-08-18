import type { ExternalProviderAuthorization } from '../../core/external-authorization-server.js'
import { badRequest } from '../../core/problem.js'
import type { D1LinearConnections } from './connections.js'
import { appAuthorizationScopes } from './scopes.js'
import type { LinearProvider, LinearViewer } from './types.js'

export function createLinearExternalAuthorization(input: {
  origin: string
  provider: LinearProvider
  connections: D1LinearConnections
  scopes: readonly string[]
}): ExternalProviderAuthorization {
  return {
    id: 'linear',
    resource: `${input.origin}/linear`,
    scopes: ['openid', 'offline_access', ...input.scopes],
    async validateGrant({ subject }) {
      await input.connections.externalAuthorization(subject)
      return true
    },
    async revoke(subject) {
      const credentials = await input.connections.externalCredentials(subject)
      await Promise.all(credentials.map((credential) => input.provider.revoke(credential.refreshToken)))
      await input.connections.revokeExternalAuthorization(subject)
    },
    begin({ providerState, scopes }) {
      return {
        url: input.provider.authorizationUrl({ actor: 'user', state: providerState, scopes: ['read'] }),
        stage: 'user',
        data: { requestedScopes: providerScopes(scopes) },
      }
    },
    async complete({ callbackUrl, intent, nextProviderState }) {
      const callback = new URL(callbackUrl)
      const code = required(callback.searchParams.get('code'), 'Linear OAuth code')
      const token = await input.provider.exchangeCode(code)
      const viewer = await input.provider.viewer(token.accessToken)
      if (intent.providerStage === 'user') {
        await input.provider.revoke(token.refreshToken)
        const providerState = nextProviderState()
        const scopes = appAuthorizationScopes(stringArray(intent.providerData.requestedScopes))
        return {
          type: 'continue',
          providerState,
          stage: 'app',
          data: { linearUser: viewer.user, requestedScopes: scopes },
          url: input.provider.authorizationUrl({ actor: 'app', state: providerState, scopes }),
        }
      }
      if (intent.providerStage !== 'app') throw badRequest('Linear OAuth authorization stage is invalid.')
      const linearUser = linearUserValue(intent.providerData.linearUser)
      const contexts = await input.connections.upsertExternalAuthorization(linearUser, viewer, token)
      const workspace = contexts[0]
      if (!workspace) throw badRequest('Linear workspace authorization is missing.')
      return {
        type: 'complete',
        grant: {
          subject: linearUser.id,
          displayName: linearUser.name,
          scopes: intent.scopes,
          authorizationDetails: [],
        },
      }
    },
  }
}

function providerScopes(scopes: string[]) {
  return appAuthorizationScopes(scopes.filter((scope) => !['openid', 'offline_access'].includes(scope)))
}

function stringArray(value: unknown) {
  if (!Array.isArray(value) || value.some((item) => typeof item !== 'string')) {
    throw badRequest('Linear OAuth scopes are invalid.')
  }
  return value as string[]
}

function linearUserValue(value: unknown): LinearViewer['user'] {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw badRequest('Linear user identity is missing.')
  const user = value as Record<string, unknown>
  if (typeof user.id !== 'string' || typeof user.name !== 'string') throw badRequest('Linear user identity is invalid.')
  return { id: user.id, name: user.name, email: typeof user.email === 'string' ? user.email : null }
}

function required(value: string | null, label: string) {
  if (!value) throw badRequest(`${label} is required.`)
  return value
}
