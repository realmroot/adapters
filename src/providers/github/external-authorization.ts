import type { Hono } from 'hono'
import type { AdapterEnv, AdapterModule } from '../../core/adapter.js'
import type { ExternalProviderAuthorization } from '../../core/external-authorization-server.js'
import { type D1ExternalOAuthStore, sha256 } from '../../core/external-oauth-store.js'
import { badRequest, forbidden } from '../../core/problem.js'
import {
  GITHUB_INSTALLATION_AUTHORIZATION_DETAIL_TYPE,
  githubInstallationAuthorizationDetail,
  githubInstallationAuthorizationDetailDisplay,
} from './authorization-details.js'
import type { D1GitHubConnections } from './connections.js'
import { permissionsToScopes } from './permissions.js'
import type { GitHubConnectionProvider } from './types.js'

const authorizationDetailsCatalogScope = 'authorization-details:read'

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
      if (detail.type !== GITHUB_INSTALLATION_AUTHORIZATION_DETAIL_TYPE || typeof detail.installation_id !== 'string')
        return false
      const installation = granted.find(
        (candidate) =>
          candidate.type === GITHUB_INSTALLATION_AUTHORIZATION_DETAIL_TYPE &&
          candidate.installation_id === detail.installation_id,
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
    scopes: ['openid', 'offline_access', authorizationDetailsCatalogScope, ...input.scopes],
    authorizationDetailsTypes: [GITHUB_INSTALLATION_AUTHORIZATION_DETAIL_TYPE],
    authorizationDetailsCatalog: {
      scope: authorizationDetailsCatalogScope,
      async list({ subject, limit, offset }) {
        const contexts = (await input.connections.externalAuthorization(subject)).contexts
        const items = contexts.slice(offset, offset + limit).map((context) => ({
          authorizationDetail: githubInstallationAuthorizationDetail(context),
          grantedScopes: context.scopes,
          display: githubInstallationAuthorizationDetailDisplay(context),
        }))
        const nextOffset = offset + limit < contexts.length ? offset + limit : null
        return {
          items,
          pagination: {
            limit,
            offset,
            total: contexts.length,
            hasMore: nextOffset !== null,
            nextOffset,
          },
        }
      },
    },
    authorizationDetailsSubset,
    async validateScopes({ subject, scopes, authorizationDetails }) {
      const active = await input.connections.externalAuthorization(subject)
      const requestedScopes = scopes.filter(
        (scope) => !['openid', 'offline_access', authorizationDetailsCatalogScope].includes(scope),
      )
      if (authorizationDetails.length === 0) {
        return requestedScopes.every((scope) => active.scopes.includes(scope))
      }
      const selectedContexts = authorizationDetails.map((detail) =>
        active.contexts.find(
          (context) =>
            detail.type === GITHUB_INSTALLATION_AUTHORIZATION_DETAIL_TYPE &&
            detail.installation_id === String(context.installationId),
        ),
      )
      return (
        selectedContexts.every(
          (context) => context !== undefined && requestedScopes.every((scope) => context.scopes.includes(scope)),
        ) &&
        authorizationDetailsSubset({
          requested: authorizationDetails,
          granted: active.contexts.map(githubInstallationAuthorizationDetail),
        })
      )
    },
    async validateGrant({ subject, scopes, authorizationDetails }) {
      const active = await input.connections.externalAuthorization(subject)
      const requestedScopes = scopes.filter(
        (scope) => !['openid', 'offline_access', authorizationDetailsCatalogScope].includes(scope),
      )
      const selectedContexts = authorizationDetails.map((detail) =>
        active.contexts.find(
          (context) =>
            detail.type === GITHUB_INSTALLATION_AUTHORIZATION_DETAIL_TYPE &&
            detail.installation_id === String(context.installationId),
        ),
      )
      return (
        selectedContexts.every(
          (context) => context !== undefined && requestedScopes.every((scope) => context.scopes.includes(scope)),
        ) &&
        authorizationDetailsSubset({
          requested: authorizationDetails,
          granted: active.contexts.map(githubInstallationAuthorizationDetail),
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
      const expectedInstallationId =
        numberValue(intent.providerData.expectedInstallationId) ?? requestedInstallationId(intent.authorizationDetails)
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
      const providerScopes = new Set(selected.flatMap((installation) => permissionsToScopes(installation.permissions)))
      const requestedProviderScopes = intent.scopes.filter(
        (scope) => !['openid', 'offline_access', authorizationDetailsCatalogScope].includes(scope),
      )
      if (requestedProviderScopes.some((scope) => !providerScopes.has(scope))) {
        const selectedInstallation = selected.length === 1 ? selected[0] : undefined
        if (!selectedInstallation) {
          return {
            type: 'error',
            error: 'access_denied',
            description: 'The selected GitHub installation permission update was not approved.',
          }
        }
        const providerState = nextProviderState()
        return {
          type: 'continue',
          providerState,
          stage: 'permission-update',
          data: {
            expectedInstallationId: selectedInstallation.id,
            permissionUpdateUrl: input.connection.permissionUpdateUrl(selectedInstallation),
            subject: String(user.id),
            displayName: user.name ?? user.login,
          },
          url: `${input.origin}/github/permission-update?state=${encodeURIComponent(providerState)}`,
        }
      }
      const contexts = await input.connections.upsertExternalAuthorization(user, installations)
      return {
        type: 'complete',
        grant: {
          subject: String(user.id),
          displayName: user.name ?? user.login,
          scopes: intent.scopes,
          authorizationDetails: contexts.map(githubInstallationAuthorizationDetail),
        },
      }
    },
    async resume({ intent }) {
      if (intent.providerStage !== 'permission-update') {
        return { type: 'error', error: 'server_error', description: 'GitHub permission update state is invalid.' }
      }
      const subject = stringValue(intent.providerData.subject)
      const displayName = stringValue(intent.providerData.displayName)
      const expectedInstallationId = numberValue(intent.providerData.expectedInstallationId)
      if (!subject || !displayName || !expectedInstallationId) {
        return { type: 'error', error: 'server_error', description: 'GitHub permission update state is incomplete.' }
      }
      const active = await input.connections.externalAuthorization(subject)
      const selected = active.contexts.find((context) => context.installationId === expectedInstallationId)
      const requestedProviderScopes = intent.scopes.filter(
        (scope) => !['openid', 'offline_access', authorizationDetailsCatalogScope].includes(scope),
      )
      if (!selected || requestedProviderScopes.some((scope) => !selected.scopes.includes(scope))) {
        return { type: 'pending' }
      }
      return {
        type: 'complete',
        grant: {
          subject,
          displayName,
          scopes: intent.scopes,
          authorizationDetails: active.contexts.map(githubInstallationAuthorizationDetail),
        },
      }
    },
  }

  return {
    authorization,
    installationCallback: {
      id: 'github-installation-callback',
      register(app: Hono<AdapterEnv>) {
        app.get('/github/permission-update', async (c) => {
          const state = required(c.req.query('state'), 'state')
          const intent = await input.oauthStore.intentByProviderState(await sha256(state))
          if (intent.providerId !== 'github' || intent.providerStage !== 'permission-update') {
            throw badRequest('GitHub permission update state is invalid.')
          }
          const installationId = numberValue(intent.providerData.expectedInstallationId)
          if (!installationId) throw badRequest('GitHub permission update installation is invalid.')
          const updateUrl = stringValue(intent.providerData.permissionUpdateUrl)
          if (!updateUrl) throw badRequest('GitHub permission update URL is invalid.')
          const nonce = randomToken()
          c.header('Cache-Control', 'no-store')
          c.header(
            'Content-Security-Policy',
            `default-src 'none'; connect-src 'self'; script-src 'nonce-${nonce}'; style-src 'nonce-${nonce}'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'`,
          )
          return c.html(
            permissionUpdatePage({
              continueUrl: `${input.origin}/oauth/github/continue?state=${encodeURIComponent(state)}`,
              nonce,
              updateUrl,
            }),
          )
        })
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
          const expectedInstallationId = numberValue(intent.providerData.expectedInstallationId)
          if (expectedInstallationId && expectedInstallationId !== installationId) {
            throw forbidden('GitHub returned a different App installation than the authorization requested.')
          }
          const providerState = randomToken()
          await input.oauthStore.advanceIntent({
            id: intent.id,
            expectedStage: 'install',
            providerStateHash: await sha256(providerState),
            providerStage: 'oauth-selected',
            providerData: { ...intent.providerData, expectedInstallationId: installationId },
          })
          return c.redirect(input.connection.authorizationUrl(providerState))
        })
      },
    },
  }
}

function numberValue(value: unknown) {
  return typeof value === 'number' && Number.isSafeInteger(value) && value > 0 ? value : null
}

function stringValue(value: unknown) {
  return typeof value === 'string' && value.length > 0 ? value : null
}

function permissionUpdatePage(input: { continueUrl: string; nonce: string; updateUrl: string }) {
  const continueUrl = JSON.stringify(input.continueUrl)
  const updateUrl = JSON.stringify(input.updateUrl)
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width,initial-scale=1">
  <title>Update GitHub permissions</title>
  <style nonce="${input.nonce}">
    :root { color-scheme: light dark; font-family: ui-sans-serif, system-ui, sans-serif; }
    body { min-height: 100vh; margin: 0; display: grid; place-items: center; background: #f6f8fa; color: #1f2328; }
    main { width: min(32rem, calc(100% - 2rem)); padding: 2rem; border: 1px solid #d0d7de; border-radius: 12px; background: #fff; box-shadow: 0 8px 24px #8c959f33; }
    h1 { margin: 0 0 .75rem; font-size: 1.4rem; }
    p { margin: .5rem 0 1.25rem; color: #59636e; line-height: 1.5; }
    button { border: 0; border-radius: 8px; padding: .75rem 1rem; background: #1f883d; color: #fff; font: inherit; font-weight: 600; cursor: pointer; }
    [hidden] { display: none; }
  </style>
</head>
<body>
  <main>
    <h1>Update GitHub permissions</h1>
    <p id="status">Accept the requested permission in GitHub. This page will return to Realmroot automatically.</p>
    <button id="open" type="button">Open GitHub permissions</button>
  </main>
  <script nonce="${input.nonce}">
    const continueUrl = ${continueUrl};
    const updateUrl = ${updateUrl};
    const button = document.querySelector('#open');
    const status = document.querySelector('#status');
    let providerWindow = null;
    function openProvider() {
      providerWindow = window.open(updateUrl, 'realmroot-github-permission-update');
      if (providerWindow) {
        button.hidden = true;
        status.textContent = 'Waiting for GitHub to confirm the permission update…';
      }
    }
    button.addEventListener('click', openProvider);
    async function poll() {
      try {
        const response = await fetch(continueUrl, { headers: { accept: 'application/json' } });
        if (response.status === 202) return window.setTimeout(poll, 1000);
        const result = await response.json();
        if (!response.ok || typeof result.redirectUrl !== 'string') throw new Error('Permission update failed.');
        providerWindow?.close();
        window.location.assign(result.redirectUrl);
      } catch (error) {
        status.textContent = error instanceof Error ? error.message : 'Permission update failed.';
        button.hidden = false;
      }
    }
    openProvider();
    window.setTimeout(poll, 1000);
  </script>
</body>
</html>`
}

function requestedInstallationId(authorizationDetails: Array<Record<string, unknown>>) {
  const ids = authorizationDetails.flatMap((detail) => {
    if (detail.type !== GITHUB_INSTALLATION_AUTHORIZATION_DETAIL_TYPE) return []
    if (typeof detail.installation_id !== 'string' || !/^\d+$/.test(detail.installation_id)) return []
    const id = Number(detail.installation_id)
    return Number.isSafeInteger(id) && id > 0 ? [id] : []
  })
  return ids.length === 1 ? ids[0] : null
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
