import { z } from 'zod'
import type { AppConfig } from '../../config.js'

const environmentSchema = z.object({
  CONTEXT7_API_ORIGIN: z.url().default('https://context7.com/api'),
  CONTEXT7_OAUTH_ISSUER: z.url().default('https://clerk.context7.com'),
  CONTEXT7_CREDENTIAL_ENCRYPTION_KEY: z.string().trim().min(1).optional(),
})

export type Context7AdapterConfig = AppConfig & {
  context7ApiOrigin: string
  context7OAuthIssuer: string
  context7CredentialEncryptionKey?: string
}

export function loadContext7Config(environment: unknown, config: AppConfig): Context7AdapterConfig {
  const parsed = environmentSchema.parse(environment)
  return {
    ...config,
    context7ApiOrigin: parsed.CONTEXT7_API_ORIGIN.replace(/\/+$/, ''),
    context7OAuthIssuer: parsed.CONTEXT7_OAUTH_ISSUER.replace(/\/+$/, ''),
    ...(parsed.CONTEXT7_CREDENTIAL_ENCRYPTION_KEY
      ? { context7CredentialEncryptionKey: parsed.CONTEXT7_CREDENTIAL_ENCRYPTION_KEY }
      : {}),
  }
}
