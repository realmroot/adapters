import type { Hono } from 'hono'

export type RequestFailure = { type: string; error?: { name: string; message: string; stack?: string } }
export type AdapterVariables = { requestId: string; correlationId: string; failure?: RequestFailure }
export type AdapterEnv = { Variables: AdapterVariables }

export interface AdapterModule {
  readonly id: string
  register(app: Hono<AdapterEnv>): void
}
