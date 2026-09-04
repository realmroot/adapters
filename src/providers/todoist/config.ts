import { z } from 'zod'
import type { AppConfig } from '../../config.js'

const environmentSchema = z.object({
  TODOIST_API_ORIGIN: z.url().default('https://api.todoist.com/api/v1'),
  TODOIST_AUTHORIZATION_ENDPOINT: z.url().default('https://app.todoist.com/oauth/authorize'),
  TODOIST_TOKEN_ENDPOINT: z.url().default('https://api.todoist.com/oauth/access_token'),
  TODOIST_REGISTRATION_ENDPOINT: z.url().default('https://api.todoist.com/oauth/register'),
  TODOIST_USERINFO_ENDPOINT: z.url().default('https://api.todoist.com/api/v1/user'),
  TODOIST_CREDENTIAL_ENCRYPTION_KEY: z.string().trim().min(1).optional(),
})

export type TodoistAdapterConfig = AppConfig & {
  todoistApiOrigin: string
  todoistAuthorizationEndpoint: string
  todoistTokenEndpoint: string
  todoistRegistrationEndpoint: string
  todoistUserInfoEndpoint: string
  todoistCredentialEncryptionKey?: string
}

export function loadTodoistConfig(environment: unknown, config: AppConfig): TodoistAdapterConfig {
  const parsed = environmentSchema.parse(environment)
  return {
    ...config,
    todoistApiOrigin: parsed.TODOIST_API_ORIGIN.replace(/\/+$/, ''),
    todoistAuthorizationEndpoint: parsed.TODOIST_AUTHORIZATION_ENDPOINT,
    todoistTokenEndpoint: parsed.TODOIST_TOKEN_ENDPOINT,
    todoistRegistrationEndpoint: parsed.TODOIST_REGISTRATION_ENDPOINT,
    todoistUserInfoEndpoint: parsed.TODOIST_USERINFO_ENDPOINT,
    ...(parsed.TODOIST_CREDENTIAL_ENCRYPTION_KEY
      ? { todoistCredentialEncryptionKey: parsed.TODOIST_CREDENTIAL_ENCRYPTION_KEY }
      : {}),
  }
}
