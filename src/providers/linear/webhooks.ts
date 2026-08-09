import { z } from 'zod'
import { badRequest, unauthorized } from '../../core/problem.js'

const permissionChangeSchema = z.object({
  type: z.literal('PermissionChange'),
  action: z.literal('teamAccessChanged'),
  organizationId: z.string().min(1),
  oauthClientId: z.string().min(1),
  appUserId: z.string().min(1),
  canAccessAllPublicTeams: z.boolean(),
  addedTeamIds: z.array(z.string()),
  removedTeamIds: z.array(z.string()),
  webhookTimestamp: z.number().int(),
  webhookId: z.string().min(1),
})
const revokedSchema = z.object({
  type: z.literal('OAuthApp'),
  action: z.literal('revoked'),
  organizationId: z.string().min(1),
  oauthClientId: z.string().min(1),
  webhookTimestamp: z.number().int(),
  webhookId: z.string().min(1),
})
const webhookSchema = z.union([permissionChangeSchema, revokedSchema])

export type LinearLifecycleWebhook = z.infer<typeof webhookSchema>

export async function verifyLinearWebhook(input: { request: Request; secret: string; clientId: string; now?: number }) {
  const signature = input.request.headers.get('linear-signature')
  const headerTimestamp = Number(input.request.headers.get('linear-timestamp'))
  const delivery = input.request.headers.get('linear-delivery')
  if (!signature || !/^[0-9a-f]{64}$/i.test(signature) || !Number.isSafeInteger(headerTimestamp) || !delivery) {
    throw unauthorized('Linear webhook authentication headers are invalid.')
  }
  const body = new Uint8Array(await input.request.arrayBuffer())
  const key = await crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(input.secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['verify'],
  )
  if (!(await crypto.subtle.verify('HMAC', key, hexBytes(signature), body))) {
    throw unauthorized('Linear webhook signature is invalid.')
  }
  let webhook: LinearLifecycleWebhook
  try {
    webhook = webhookSchema.parse(JSON.parse(new TextDecoder().decode(body)))
  } catch {
    throw badRequest('Linear webhook payload is invalid or unsupported.')
  }
  const now = input.now ?? Date.now()
  if (Math.abs(now - headerTimestamp) > 60_000 || Math.abs(now - webhook.webhookTimestamp) > 60_000) {
    throw unauthorized('Linear webhook timestamp is outside the accepted window.')
  }
  if (webhook.oauthClientId !== input.clientId) throw unauthorized('Linear webhook OAuth client is invalid.')
  if (delivery !== webhook.webhookId) throw unauthorized('Linear webhook delivery identity is invalid.')
  return { deliveryId: delivery, webhook }
}

function hexBytes(value: string) {
  return Uint8Array.from(value.match(/.{2}/g) ?? [], (byte) => Number.parseInt(byte, 16))
}
