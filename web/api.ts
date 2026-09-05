import { hc, type InferResponseType } from 'hono/client'
import type { ConsoleApp } from '../.console-types/console/routes.js'

export const api = hc<ConsoleApp>('/console', { init: { credentials: 'same-origin' } }).api
export type Provider = InferResponseType<typeof api.providers.$get>['items'][number]

export async function checked<T>(response: { ok: boolean; status: number; json(): Promise<T> }): Promise<T> {
  if (!response.ok) {
    throw new Error('We couldn’t load this information. Please try again.')
  }
  return response.json()
}
