import { z } from 'zod'
import { failedDependency } from './problem.js'
import type { AgentPrincipal } from './realmroot-auth.js'

const discoverySchema = z.object({ agentinfo_endpoint: z.url() })
const agentInfoSchema = z.object({
  iss: z.string(),
  sub: z.string(),
  name: z.string().min(1).max(200),
  picture: z.url(),
})

export type AgentDisplay = Readonly<{ name: string; picture: string; identityUrl: string }>
export type AgentInfoResolver = { resolve(principal: AgentPrincipal): Promise<AgentDisplay> }

export function createAgentInfoResolver(fetcher: typeof fetch = fetch, configuredEndpoint?: string): AgentInfoResolver {
  const endpoints = new Map<string, string>()
  return {
    async resolve(principal) {
      let endpoint = configuredEndpoint ?? endpoints.get(principal.actor.issuer)
      if (!endpoint) {
        const discoveryUrl = `${principal.actor.issuer}/.well-known/openid-configuration`
        const response = await fetcher(discoveryUrl, { signal: AbortSignal.timeout(5_000) })
        if (!response.ok) throw failedDependency('Realmroot AgentInfo discovery failed.')
        endpoint = discoverySchema.parse(await response.json()).agentinfo_endpoint
        endpoints.set(principal.actor.issuer, endpoint)
      }
      const url = new URL(endpoint)
      url.searchParams.set('sub', principal.actor.subject)
      const response = await fetcher(url, { signal: AbortSignal.timeout(5_000) })
      if (!response.ok) throw failedDependency('Realmroot AgentInfo resolution failed.')
      const info = agentInfoSchema.parse(await response.json())
      if (info.iss !== principal.actor.issuer || info.sub !== principal.actor.subject) {
        throw failedDependency('Realmroot AgentInfo did not match the authenticated Agent.')
      }
      return Object.freeze({ name: info.name, picture: info.picture, identityUrl: url.toString() })
    },
  }
}
