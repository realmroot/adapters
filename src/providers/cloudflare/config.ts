import { z } from 'zod'
import type { AppConfig } from '../../config.js'

const schema = z
  .object({
    CLOUDFLARE_API_ORIGIN: z.url().optional(),
    REALMROOT_APPLICATION_CLIENT_ID: z.string().min(1).optional(),
    REALMROOT_APPLICATION_CLIENT_SECRET: z.string().min(1).optional(),
  })
  .refine(
    (value) => Boolean(value.REALMROOT_APPLICATION_CLIENT_ID) === Boolean(value.REALMROOT_APPLICATION_CLIENT_SECRET),
    'Realmroot Application Client ID and Secret must be configured together.',
  )

export type CloudflareAdapterConfig = NonNullable<ReturnType<typeof loadCloudflareConfig>>

export function loadCloudflareConfig(environment: unknown, app: AppConfig) {
  const parsed = schema.parse(environment)
  if (!parsed.REALMROOT_APPLICATION_CLIENT_ID || !parsed.REALMROOT_APPLICATION_CLIENT_SECRET) return null
  return {
    origin: app.origin,
    realmrootIssuer: app.realmrootIssuer,
    applicationClientId: parsed.REALMROOT_APPLICATION_CLIENT_ID,
    applicationClientSecret: parsed.REALMROOT_APPLICATION_CLIENT_SECRET,
    cloudflareApiOrigin: strip(parsed.CLOUDFLARE_API_ORIGIN ?? 'https://api.cloudflare.com/client/v4'),
  }
}

function strip(value: string) {
  return value.replace(/\/+$/, '')
}
