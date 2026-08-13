import { z } from 'zod'

const environmentSchema = z.object({
  ADAPTER_ORIGIN: z.url().optional(),
  REALMROOT_ISSUER: z.url(),
  REALMROOT_JWKS_URL: z.url(),
  REALMROOT_AGENT_PROFILE_URI_TEMPLATE: z.string().trim().min(1).optional(),
  ADAPTER_OAUTH_SIGNING_PRIVATE_JWK: z.string().trim().min(1).optional(),
})

export type AppConfig = {
  origin: string
  realmrootIssuer: string
  realmrootJwksUrl: string
  realmrootAgentProfileUriTemplate?: string
  oauthSigningPrivateJwk?: string
}

export function loadConfig(environment: unknown, requestUrl: string): AppConfig {
  const parsed = environmentSchema.parse(environment)
  return {
    origin: stripTrailingSlash(parsed.ADAPTER_ORIGIN ?? new URL(requestUrl).origin),
    realmrootIssuer: stripTrailingSlash(parsed.REALMROOT_ISSUER),
    realmrootJwksUrl: parsed.REALMROOT_JWKS_URL,
    ...(parsed.ADAPTER_OAUTH_SIGNING_PRIVATE_JWK
      ? { oauthSigningPrivateJwk: parsed.ADAPTER_OAUTH_SIGNING_PRIVATE_JWK }
      : {}),
    ...(parsed.REALMROOT_AGENT_PROFILE_URI_TEMPLATE
      ? { realmrootAgentProfileUriTemplate: parsed.REALMROOT_AGENT_PROFILE_URI_TEMPLATE }
      : {}),
  }
}

function stripTrailingSlash(value: string) {
  return value.replace(/\/+$/, '')
}
