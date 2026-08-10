import { z } from 'zod'
import type { AppConfig } from '../../config.js'

const githubEnvironmentSchema = z
  .object({
    GITHUB_API_ORIGIN: z.url().default('https://api.github.com'),
    GITHUB_UPLOADS_ORIGIN: z.url().default('https://uploads.github.com'),
    GITHUB_APP_ID: z.string().trim().min(1).optional(),
    GITHUB_PRIVATE_KEY: z.string().trim().min(1).optional(),
    GITHUB_CLIENT_ID: z.string().trim().min(1).optional(),
    GITHUB_CLIENT_SECRET: z.string().trim().min(1).optional(),
    GITHUB_WEBHOOK_SECRET: z.string().min(32).optional(),
    REALMROOT_APPLICATION_CLIENT_ID: z.string().trim().min(1).optional(),
    REALMROOT_APPLICATION_CLIENT_SECRET: z.string().trim().min(1).optional(),
    REALMROOT_GITHUB_RESOURCE_SERVER_ID: z.string().trim().min(1).optional(),
  })
  .superRefine((value, context) => {
    const configured = [
      value.REALMROOT_APPLICATION_CLIENT_ID,
      value.REALMROOT_APPLICATION_CLIENT_SECRET,
      value.REALMROOT_GITHUB_RESOURCE_SERVER_ID,
    ].filter(Boolean).length
    if (configured !== 0 && configured !== 3) {
      context.addIssue({
        code: 'custom',
        message:
          'Realmroot Connection Events require the Application client ID, client secret, and Resource Server ID.',
      })
    }
  })

export type GitHubAdapterConfig = AppConfig & {
  githubApiOrigin: string
  githubUploadsOrigin: string
  githubAppId?: string
  githubPrivateKey?: string
  githubClientId?: string
  githubClientSecret?: string
  githubWebhookSecret?: string
  realmrootApplicationClientId?: string
  realmrootApplicationClientSecret?: string
  realmrootGitHubResourceServerId?: string
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
    ...(parsed.GITHUB_WEBHOOK_SECRET ? { githubWebhookSecret: parsed.GITHUB_WEBHOOK_SECRET } : {}),
    ...(parsed.REALMROOT_APPLICATION_CLIENT_ID
      ? { realmrootApplicationClientId: parsed.REALMROOT_APPLICATION_CLIENT_ID }
      : {}),
    ...(parsed.REALMROOT_APPLICATION_CLIENT_SECRET
      ? { realmrootApplicationClientSecret: parsed.REALMROOT_APPLICATION_CLIENT_SECRET }
      : {}),
    ...(parsed.REALMROOT_GITHUB_RESOURCE_SERVER_ID
      ? { realmrootGitHubResourceServerId: parsed.REALMROOT_GITHUB_RESOURCE_SERVER_ID }
      : {}),
  }
}
