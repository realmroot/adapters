import { z } from 'zod'

const environmentSchema = z.object({
  ADAPTER_ORIGIN: z.url().optional(),
  REALMROOT_ISSUER: z.url(),
  REALMROOT_JWKS_URL: z.url(),
  REALMROOT_AGENTINFO_ENDPOINT: z.url().optional(),
  GITHUB_API_ORIGIN: z.url().default('https://api.github.com'),
  GITHUB_APP_ID: z.string().trim().min(1).optional(),
  GITHUB_PRIVATE_KEY: z.string().trim().min(1).optional(),
  GITHUB_CLIENT_ID: z.string().trim().min(1).optional(),
  GITHUB_CLIENT_SECRET: z.string().trim().min(1).optional(),
})

export type AppConfig = {
  origin: string
  realmrootIssuer: string
  realmrootJwksUrl: string
  realmrootAgentInfoEndpoint?: string
  githubApiOrigin: string
  githubAppId?: string
  githubPrivateKey?: string
  githubClientId?: string
  githubClientSecret?: string
}

export function loadConfig(environment: unknown, requestUrl: string): AppConfig {
  const parsed = environmentSchema.parse(environment)
  return {
    origin: stripTrailingSlash(parsed.ADAPTER_ORIGIN ?? new URL(requestUrl).origin),
    realmrootIssuer: stripTrailingSlash(parsed.REALMROOT_ISSUER),
    realmrootJwksUrl: parsed.REALMROOT_JWKS_URL,
    githubApiOrigin: stripTrailingSlash(parsed.GITHUB_API_ORIGIN),
    ...(parsed.REALMROOT_AGENTINFO_ENDPOINT ? { realmrootAgentInfoEndpoint: parsed.REALMROOT_AGENTINFO_ENDPOINT } : {}),
    ...(parsed.GITHUB_APP_ID ? { githubAppId: parsed.GITHUB_APP_ID } : {}),
    ...(parsed.GITHUB_PRIVATE_KEY ? { githubPrivateKey: parsed.GITHUB_PRIVATE_KEY } : {}),
    ...(parsed.GITHUB_CLIENT_ID ? { githubClientId: parsed.GITHUB_CLIENT_ID } : {}),
    ...(parsed.GITHUB_CLIENT_SECRET ? { githubClientSecret: parsed.GITHUB_CLIENT_SECRET } : {}),
  }
}

function stripTrailingSlash(value: string) {
  return value.replace(/\/+$/, '')
}
