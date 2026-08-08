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

export type BrokeredConnectionRequest = z.infer<typeof requestSchema>

export function createConnectionRequestVerifier(config: AppConfig) {
  const keys = createRemoteJWKSet(new URL(config.realmrootJwksUrl))
  return async (request: string): Promise<BrokeredConnectionRequest> => {
    const verified = await jwtVerify(request, keys, {
      algorithms: ['RS256'],
      issuer: config.realmrootIssuer,
      audience: `${config.origin}/github`,
    }).catch(() => {
      throw unauthorized('The Realmroot account connection request is invalid.')
    })
    return requestSchema.parse(verified.payload)
  }
}
