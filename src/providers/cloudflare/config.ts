import { z } from 'zod'
import type { AppConfig } from '../../config.js'

const schema = z
  .object({
    CLOUDFLARE_API_ORIGIN: z.url().optional(),
    CLOUDFLARE_AUTHORIZATION_ORIGIN: z.url().optional(),
    CLOUDFLARE_CLIENT_ID: z.string().min(1).optional(),
    CLOUDFLARE_CLIENT_SECRET: z.string().min(1).optional(),
    CLOUDFLARE_CREDENTIAL_ENCRYPTION_KEY: z.string().min(1).optional(),
  })
  .refine(
    (value) =>
      [value.CLOUDFLARE_CLIENT_ID, value.CLOUDFLARE_CLIENT_SECRET, value.CLOUDFLARE_CREDENTIAL_ENCRYPTION_KEY].every(
        Boolean,
      ) ||
      [value.CLOUDFLARE_CLIENT_ID, value.CLOUDFLARE_CLIENT_SECRET, value.CLOUDFLARE_CREDENTIAL_ENCRYPTION_KEY].every(
        (item) => !item,
      ),
    'Cloudflare Client ID, Secret, and credential encryption key must be configured together.',
  )

export type CloudflareAdapterConfig = NonNullable<ReturnType<typeof loadCloudflareConfig>>

export function loadCloudflareConfig(environment: unknown, app: AppConfig) {
  const parsed = schema.parse(environment)
  if (!parsed.CLOUDFLARE_CLIENT_ID || !parsed.CLOUDFLARE_CLIENT_SECRET || !parsed.CLOUDFLARE_CREDENTIAL_ENCRYPTION_KEY)
    return null
  return {
    origin: app.origin,
    clientId: parsed.CLOUDFLARE_CLIENT_ID,
    clientSecret: parsed.CLOUDFLARE_CLIENT_SECRET,
    credentialEncryptionKey: parsed.CLOUDFLARE_CREDENTIAL_ENCRYPTION_KEY,
    authorizationOrigin: strip(parsed.CLOUDFLARE_AUTHORIZATION_ORIGIN ?? 'https://dash.cloudflare.com'),
    cloudflareApiOrigin: strip(parsed.CLOUDFLARE_API_ORIGIN ?? 'https://api.cloudflare.com/client/v4'),
  }
}

function strip(value: string) {
  return value.replace(/\/+$/, '')
}
