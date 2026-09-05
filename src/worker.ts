import { tracing } from 'cloudflare:workers'
import { createApp } from './app.js'
import { loadConfig } from './config.js'
import { consoleRoutes } from './console/routes.js'
import { D1ExternalOAuthStore } from './core/external-oauth-store.js'
import { createProviderModules } from './providers/registry.js'
import { D1RuntimeState } from './storage/d1-runtime-state.js'

export default {
  async fetch(request, env, executionContext) {
    return tracing.enterSpan('adapter.request.prepare', async (span) => {
      span.setAttribute('url.path', new URL(request.url).pathname)
      const config = loadConfig(env, request.url)
      if (new URL(request.url).pathname.startsWith('/console/')) {
        const app = createApp([])
        app.route('/console', consoleRoutes)
        return app.fetch(request, env, executionContext)
      }
      const adapters = await createProviderModules({
        env,
        config,
        executionContext,
        state: new D1RuntimeState(env.DB),
        oauthStore: new D1ExternalOAuthStore(env.DB),
        signingPrivateJwk: config.oauthSigningPrivateJwk ? JSON.parse(config.oauthSigningPrivateJwk) : undefined,
      })
      const app = createApp(adapters)
      return tracing.enterSpan('adapter.router.dispatch', () => app.fetch(request, env, executionContext))
    })
  },
} satisfies ExportedHandler<Env>
