import { readFile } from 'node:fs/promises'
import { z } from 'zod'

const environmentSchema = z.object({
  PORT: z.coerce.number().int().min(1).max(65535).default(4103),
  ORIGIN: z.url().default('http://127.0.0.1:4103'),
  REALMROOT_ORIGIN: z.url().default('http://127.0.0.1:4179'),
  REALMROOT_ISSUER: z.url().optional(),
  REALMROOT_JWKS_URL: z.url().optional(),
  REALMROOT_AGENTINFO_ENDPOINT: z.url().optional(),
  GITHUB_API_ORIGIN: z.url().default('https://api.github.com'),
  GITHUB_APP_ID: z.string().trim().min(1).optional(),
  GITHUB_PRIVATE_KEY_PATH: z.string().trim().min(1).optional(),
})

export type AppConfig = {
  port: number
  origin: string
  realmrootOrigin: string
  realmrootIssuer: string
  realmrootJwksUrl: string
  realmrootAgentInfoEndpoint?: string
  githubApiOrigin: string
  githubAppId?: string
  githubPrivateKey?: string
}

export async function loadConfig(
  environment: NodeJS.ProcessEnv = process.env,
  fetcher: typeof fetch = fetch,
): Promise<AppConfig> {
  const parsed = environmentSchema.parse(environment)
  const realmrootOrigin = stripTrailingSlash(parsed.REALMROOT_ORIGIN)
  const discovery = await discoverRealmroot(realmrootOrigin, fetcher)
  const githubPrivateKey = parsed.GITHUB_PRIVATE_KEY_PATH
    ? await readFile(parsed.GITHUB_PRIVATE_KEY_PATH, 'utf8')
    : undefined

  return {
    port: parsed.PORT,
    origin: stripTrailingSlash(parsed.ORIGIN),
    realmrootOrigin,
    realmrootIssuer: parsed.REALMROOT_ISSUER ?? discovery.issuer,
    realmrootJwksUrl: parsed.REALMROOT_JWKS_URL ?? discovery.jwks_uri,
    realmrootAgentInfoEndpoint: parsed.REALMROOT_AGENTINFO_ENDPOINT ?? discovery.agentinfo_endpoint,
    githubApiOrigin: stripTrailingSlash(parsed.GITHUB_API_ORIGIN),
    ...(parsed.GITHUB_APP_ID ? { githubAppId: parsed.GITHUB_APP_ID } : {}),
    ...(githubPrivateKey ? { githubPrivateKey } : {}),
  }
}

async function discoverRealmroot(origin: string, fetcher: typeof fetch) {
  const response = await fetcher(`${origin}/api/auth/.well-known/openid-configuration`, {
    signal: AbortSignal.timeout(5_000),
  })
  if (!response.ok) throw new Error(`Realmroot discovery failed with ${response.status}.`)
  return z.object({ issuer: z.url(), jwks_uri: z.url(), agentinfo_endpoint: z.url() }).parse(await response.json())
}

function stripTrailingSlash(value: string) {
  return value.replace(/\/+$/, '')
}
