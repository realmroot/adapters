import { z } from 'zod'
import type { AppConfig } from '../../config.js'

const linearEnvironmentSchema = z.object({
  LINEAR_API_ORIGIN: z.url().default('https://api.linear.app'),
  REALMROOT_APPLICATION_CLIENT_ID: z.string().min(1),
  REALMROOT_APPLICATION_CLIENT_SECRET: z.string().min(1),
})

export type LinearAdapterConfig = ReturnType<typeof loadLinearConfig>

export function loadLinearConfig(environment: unknown, config: AppConfig) {
  const parsed = linearEnvironmentSchema.parse(environment)
  return {
    ...config,
    linearApiOrigin: parsed.LINEAR_API_ORIGIN.replace(/\/+$/, ''),
    applicationClientId: parsed.REALMROOT_APPLICATION_CLIENT_ID,
    applicationClientSecret: parsed.REALMROOT_APPLICATION_CLIENT_SECRET,
  }
}
