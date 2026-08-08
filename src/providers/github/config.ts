import { z } from 'zod'
import type { AppConfig } from '../../config.js'

const githubEnvironmentSchema = z.object({
  GITHUB_API_ORIGIN: z.url().default('https://api.github.com'),
  GITHUB_UPLOADS_ORIGIN: z.url().default('https://uploads.github.com'),
  GITHUB_APP_ID: z.string().trim().min(1).optional(),
  GITHUB_PRIVATE_KEY: z.string().trim().min(1).optional(),
  GITHUB_CLIENT_ID: z.string().trim().min(1).optional(),
  GITHUB_CLIENT_SECRET: z.string().trim().min(1).optional(),
})

export type GitHubAdapterConfig = AppConfig & {
  githubApiOrigin: string
  githubUploadsOrigin: string
  githubAppId?: string
  githubPrivateKey?: string
  githubClientId?: string
  githubClientSecret?: string
}

export function loadGitHubConfig(environment: unknown, config: AppConfig): GitHubAdapterConfig {
  const parsed = githubEnvironmentSchema.parse(environment)
  return {
    ...config,
    githubApiOrigin: parsed.GITHUB_API_ORIGIN.replace(/\/+$/, ''),
    githubUploadsOrigin: parsed.GITHUB_UPLOADS_ORIGIN.replace(/\/+$/, ''),
    ...(parsed.GITHUB_APP_ID ? { githubAppId: parsed.GITHUB_APP_ID } : {}),
    ...(parsed.GITHUB_PRIVATE_KEY ? { githubPrivateKey: parsed.GITHUB_PRIVATE_KEY } : {}),
    ...(parsed.GITHUB_CLIENT_ID ? { githubClientId: parsed.GITHUB_CLIENT_ID } : {}),
    ...(parsed.GITHUB_CLIENT_SECRET ? { githubClientSecret: parsed.GITHUB_CLIENT_SECRET } : {}),
  }
}
