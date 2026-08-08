import { z } from 'zod'
import { failedDependency } from './problem.js'
import type { AgentPrincipal } from './realmroot-auth.js'

const discoverySchema = z.object({ agent_profile_uri_template: z.string().trim().min(1) })
const agentInfoSchema = z.object({
  type: z.literal('agent'),
  view: z.literal('summary'),
  issuer: z.string(),
  subject: z.string(),
  name: z.string().min(1).max(200),
  picture: z.url(),
})

export type AgentDisplay = Readonly<{ name: string; picture: string; identityUrl: string }>
export type AgentInfoResolver = { resolve(principal: AgentPrincipal): Promise<AgentDisplay> }

export function createAgentInfoResolver(fetcher: typeof fetch = fetch, configuredTemplate?: string): AgentInfoResolver {
  const templates = new Map<string, string>()
  return {
    async resolve(principal) {
      let template = configuredTemplate ?? templates.get(principal.actor.issuer)
      if (!template) {
        const discoveryUrl = new URL('/.well-known/agent-configuration', principal.actor.issuer)
        const response = await fetcher(discoveryUrl, { signal: AbortSignal.timeout(5_000) })
        if (!response.ok) throw failedDependency('Realmroot Agent Profile discovery failed.')
        template = discoverySchema.parse(await response.json()).agent_profile_uri_template
        templates.set(principal.actor.issuer, template)
      }
      const url = profileUrl(template, principal.actor.issuer, principal.actor.subject)
      const response = await fetcher(url, { signal: AbortSignal.timeout(5_000) })
      if (!response.ok) throw failedDependency('Realmroot Agent Profile resolution failed.')
      const info = agentInfoSchema.parse(await response.json())
      if (info.issuer !== principal.actor.issuer || info.subject !== principal.actor.subject) {
        throw failedDependency('Realmroot Agent Profile did not match the authenticated Agent.')
      }
      return Object.freeze({
        name: info.name,
        picture: info.picture,
        identityUrl: publicProfilePageUrl(principal.actor.issuer, principal.actor.subject),
      })
    },
  }
}

function publicProfilePageUrl(issuer: string, subject: string) {
  return new URL(`/agents/${encodeURIComponent(subject)}`, issuer).toString()
}

function profileUrl(template: string, issuer: string, subject: string) {
  if (template.split('{subject}').length !== 2) {
    throw failedDependency('Realmroot Agent Profile URI template is invalid.')
  }
  const url = new URL(template.replace('{subject}', encodeURIComponent(subject)))
  if (url.origin !== new URL(issuer).origin) {
    throw failedDependency('Realmroot Agent Profile URI template has a different origin.')
  }
  return url
}
