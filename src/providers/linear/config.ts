import { z } from 'zod'
import type { AppConfig } from '../../config.js'

const linearEnvironmentSchema = z.object({
  LINEAR_API_ORIGIN: z.url().default('https://api.linear.app'),
  LINEAR_AUTHORIZATION_ORIGIN: z.url().default('https://linear.app'),
  LINEAR_CLIENT_ID: z.string().trim().min(1).optional(),
  LINEAR_CLIENT_SECRET: z.string().trim().min(1).optional(),
  LINEAR_CREDENTIAL_ENCRYPTION_KEY: z.string().trim().min(1).optional(),
  LINEAR_WEBHOOK_SECRET: z.string().trim().min(1).optional(),
})

export type LinearAdapterConfig = AppConfig & {
  linearApiOrigin: string
  linearAuthorizationOrigin: string
  linearClientId?: string
  linearClientSecret?: string
  linearCredentialEncryptionKey?: string
  linearWebhookSecret?: string
}

export function loadLinearConfig(environment: unknown, config: AppConfig): LinearAdapterConfig {
  const parsed = linearEnvironmentSchema.parse(environment)
  return {
    ...config,
    linearApiOrigin: parsed.LINEAR_API_ORIGIN.replace(/\/+$/, ''),
    linearAuthorizationOrigin: parsed.LINEAR_AUTHORIZATION_ORIGIN.replace(/\/+$/, ''),
    ...(parsed.LINEAR_CLIENT_ID ? { linearClientId: parsed.LINEAR_CLIENT_ID } : {}),
    ...(parsed.LINEAR_CLIENT_SECRET ? { linearClientSecret: parsed.LINEAR_CLIENT_SECRET } : {}),
    ...(parsed.LINEAR_CREDENTIAL_ENCRYPTION_KEY
      ? { linearCredentialEncryptionKey: parsed.LINEAR_CREDENTIAL_ENCRYPTION_KEY }
      : {}),
    ...(parsed.LINEAR_WEBHOOK_SECRET ? { linearWebhookSecret: parsed.LINEAR_WEBHOOK_SECRET } : {}),
  }
}
