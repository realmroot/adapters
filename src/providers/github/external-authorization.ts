import type { Hono } from 'hono'
import type { AdapterEnv, AdapterModule } from '../../core/adapter.js'
import type { ExternalProviderAuthorization } from '../../core/external-authorization-server.js'
import { type D1ExternalOAuthStore, sha256 } from '../../core/external-oauth-store.js'
import { badRequest, forbidden } from '../../core/problem.js'
import type { D1GitHubConnections } from './connections.js'
import { permissionsToScopes } from './permissions.js'
import type { GitHubConnectionProvider } from './types.js'

export function createGitHubExternalAuthorization(input: {
  origin: string
  connection: GitHubConnectionProvider
  connections: D1GitHubConnections
  oauthStore: D1ExternalOAuthStore
  scopes: readonly string[]
}): { authorization: ExternalProviderAuthorization; installationCallback: AdapterModule } {
  const authorizationDetailsSubset = ({
    requested,
    granted,
  }: {
    requested: Array<Record<string, unknown>>
    granted: Array<Record<string, unknown>>
  }) =>
    requested.every((detail) => {
      if (detail.type !== 'github_installation' || typeof detail.installation_id !== 'string') return false
      const installation = granted.find(
        (candidate) => candidate.type === 'github_installation' && candidate.installation_id === detail.installation_id,
      )
      if (!installation) return false
      if (!Array.isArray(detail.repositories)) return true
      if (installation.repository_selection === 'all') return true
      if (!Array.isArray(installation.repositories)) return false
      const grantedIds = new Set(
        installation.repositories.flatMap((repository) =>
          repository &&
          typeof repository === 'object' &&
          !Array.isArray(repository) &&
          typeof (repository as Record<string, unknown>).id === 'string'
            ? [(repository as Record<string, unknown>).id]
            : [],
        ),
      )
      return detail.repositories.every(
        (repository) =>
          repository &&
          typeof repository === 'object' &&
          !Array.isArray(repository) &&
          typeof (repository as Record<string, unknown>).id === 'string' &&
          grantedIds.has((repository as Record<string, unknown>).id as string),
      )
    })

  const authorization: ExternalProviderAuthorization = {
    id: 'github',
    resource: `${input.origin}/github`,
    scopes: ['openid', 'offline_access', ...input.scopes],
    authorizationDetailsTypes: ['github_installation'],
    authorizationDetailsSubset,
    async validateGrant({ subject, scopes, authorizationDetails }) {
      const active = await input.connections.externalAuthorization(subject)
      return (
        scopes.every((scope) => ['openid', 'offline_access'].includes(scope) || active.scopes.includes(scope)) &&
        authorizationDetailsSubset({
          requested: authorizationDetails,
          granted: active.contexts.map(contextAuthorizationDetail),
        })
      )
    },
    revoke(subject) {
      return input.connections.revokeExternalAuthorization(subject)
    },
    begin({ providerState }) {
      return { url: input.connection.authorizationUrl(providerState), stage: 'oauth' }
    },
    async complete({ callbackUrl, intent, nextProviderState }) {
      if (!['oauth', 'oauth-selected'].includes(intent.providerStage)) {
        throw badRequest('GitHub OAuth authorization stage is invalid.')
      }
      const callback = new URL(callbackUrl)
      const userToken = await input.connection.exchangeUserCode(required(callback.searchParams.get('code'), 'code'))
      const [user, installations] = await Promise.all([
        input.connection.getUser(userToken),
        input.connection.listUserInstallations(userToken),
      ])
      const expectedInstallationId = numberValue(intent.providerData.expectedInstallationId)
      if (expectedInstallationId && !installations.some((installation) => installation.id === expectedInstallationId)) {
        throw forbidden('The GitHub user cannot manage the selected App installation.')
      }
      if (installations.length === 0) {
        const providerState = nextProviderState()
        return {
          type: 'continue',
          providerState,
          stage: 'install',
          data: {},
          url: await input.connection.newInstallationUrl(providerState),
        }
      }
      const selected = expectedInstallationId
        ? installations.filter((installation) => installation.id === expectedInstallationId)
        : installations
      const contexts = await input.connections.upsertExternalAuthorization(user, selected)
      const providerScopes = new Set(selected.flatMap((installation) => permissionsToScopes(installation.permissions)))
      const requestedProviderScopes = intent.scopes.filter((scope) => !['openid', 'offline_access'].includes(scope))
      if (requestedProviderScopes.some((scope) => !providerScopes.has(scope))) {
        throw forbidden('The selected GitHub installation does not grant every requested scope.')
      }
      return {
        type: 'complete',
        grant: {
          subject: String(user.id),
          displayName: user.name ?? user.login,
          scopes: intent.scopes,
          authorizationDetails: contexts.map(contextAuthorizationDetail),
        },
      }
    },
  }

  return {
    authorization,
    installationCallback: {
      id: 'github-installation-callback',
      register(app: Hono<AdapterEnv>) {
        app.get('/github/account-connection-installations', async (c) => {
          const state = required(c.req.query('state'), 'state')
          const installationId = Number(required(c.req.query('installation_id'), 'installation_id'))
          if (!Number.isSafeInteger(installationId) || installationId <= 0) {
            throw badRequest('GitHub installation_id is invalid.')
          }
          const intent = await input.oauthStore.intentByProviderState(await sha256(state))
          if (intent.providerId !== 'github' || intent.providerStage !== 'install') {
            throw badRequest('GitHub installation authorization state is invalid.')
          }
          const providerState = randomToken()
          await input.oauthStore.advanceIntent({
            id: intent.id,
            expectedStage: 'install',
            providerStateHash: await sha256(providerState),
            providerStage: 'oauth-selected',
            providerData: { expectedInstallationId: installationId },
          })
          return c.redirect(input.connection.authorizationUrl(providerState))
        })
      },
    },
  }
}

function contextAuthorizationDetail(
  context: Awaited<ReturnType<D1GitHubConnections['activeInstallationsForReference']>>[number],
) {
  return {
    type: 'github_installation',
    installation_id: String(context.installationId),
    account_login: context.accountLogin,
    target_type: context.targetType,
    repository_selection: context.repositorySelection,
    ...(context.repositorySelection === 'selected'
      ? {
          repositories: context.repositories.map((repository) => ({
            id: String(repository.id),
            full_name: repository.fullName,
          })),
        }
      : {}),
  }
}

function numberValue(value: unknown) {
  return typeof value === 'number' && Number.isSafeInteger(value) && value > 0 ? value : null
}

function required(value: string | null | undefined, name: string) {
  if (!value) throw badRequest(`${name} is required.`)
  return value
}

function randomToken() {
  const bytes = crypto.getRandomValues(new Uint8Array(24))
  return btoa(String.fromCharCode(...bytes))
    .replaceAll('+', '-')
    .replaceAll('/', '_')
    .replace(/=+$/, '')
}
