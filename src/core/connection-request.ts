import { createRemoteJWKSet, jwtVerify } from 'jose'
import { z } from 'zod'
import type { AppConfig } from '../config.js'
import { unauthorized } from './problem.js'

const requestSchema = z.object({
  sub: z.string().min(1),
  jti: z.string().min(1),
  state: z.string().min(1),
  connection_id: z.string().min(1),
  expected_external_subject: z.string().min(1).nullable(),
  owner_type: z.enum(['user', 'organization']),
  callback_uri: z.url(),
  code_challenge: z.string().min(32),
  code_challenge_method: z.literal('S256'),
  scope: z.string(),
  authorization_details: z.array(z.record(z.string(), z.unknown())),
})

const revocationRequestSchema = z.object({
  sub: z.string().min(1),
  jti: z.string().min(1),
  exp: z.number().int().positive(),
  connection_id: z.string().min(1),
  resource_authorization_id: z.string().min(1),
  broker_reference: z.string().min(1),
})

export type BrokeredConnectionRequest = z.infer<typeof requestSchema>
export type BrokeredRevocationRequest = z.infer<typeof revocationRequestSchema>

export function createBrokerRequestVerifiers(config: AppConfig) {
  const keys = createRemoteJWKSet(new URL(config.realmrootJwksUrl))
  return {
    verifyConnection: (request: string) =>
      verify(request, requestSchema, '11 minutes', 'The Realmroot account connection request is invalid.'),
    verifyRevocation: (request: string) =>
      verify(request, revocationRequestSchema, '2 minutes', 'The Realmroot account revocation request is invalid.'),
  }

  async function verify<T>(request: string, schema: z.ZodType<T>, maxTokenAge: string, detail: string): Promise<T> {
    try {
      const verified = await jwtVerify(request, keys, {
        algorithms: ['RS256'],
        issuer: config.realmrootIssuer,
        audience: `${config.origin}/github`,
        maxTokenAge,
      })
      return schema.parse(verified.payload)
    } catch {
      throw unauthorized(detail)
    }
  }
}
