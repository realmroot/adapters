import type { AgentDisplay } from './agent-info.js'
import { badRequest } from './problem.js'
import type { AgentPrincipal } from './realmroot-auth.js'

const marker = '<!-- realmroot-agent:'

export function attributedBody(
  body: string | undefined,
  principal: AgentPrincipal,
  display: AgentDisplay,
  requestId: string,
) {
  const original = body ?? ''
  if (original.includes(marker) || original.includes('data-realmroot-agent')) {
    throw badRequest('The body contains a reserved Realmroot attribution marker.', 'reserved-attribution')
  }
  const name = escapeMarkdown(display.name)
  const visible = `<sub data-realmroot-agent>🤖 Created by [${name}](${display.identityUrl}) via [Realmroot](https://realmroot.dev)</sub>`
  const machine = `${marker} issuer=${encodeURIComponent(principal.actor.issuer)} subject=${encodeURIComponent(principal.actor.subject)} request=${encodeURIComponent(requestId)} -->`
  return `${original}${original ? '\n\n' : ''}---\n\n${visible}\n${machine}`
}

function escapeMarkdown(value: string) {
  return value.replace(/[\\[\]()_*`]/g, '\\$&')
}
