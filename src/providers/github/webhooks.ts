import { z } from 'zod'
import type { ConnectionEventSink } from '../../core/connection-events.js'
import { sha256Hex } from '../../core/digest.js'
import { badRequest, HttpProblem } from '../../core/problem.js'
import type { GitHubConnectionStore, GitHubLifecycleChange } from './connections.js'
import { permissionsToScopes } from './permissions.js'

const permissionAccessSchema = z.enum(['read', 'write', 'admin'])
const githubTimestampSchema = z.iso.datetime({ offset: true })
const installationSchema = z.object({
  id: z.number().int().positive(),
  permissions: z.record(z.string(), permissionAccessSchema).optional(),
  updated_at: githubTimestampSchema,
  suspended_at: githubTimestampSchema.nullable().optional(),
})
const installationEventSchema = z.object({
  action: z.enum(['deleted', 'suspend', 'unsuspend', 'new_permissions_accepted']),
  installation: installationSchema,
})
const repositoriesEventSchema = z.object({
  action: z.enum(['added', 'removed']),
  installation: installationSchema,
  repository_selection: z.enum(['all', 'selected']),
  repositories_added: z.array(z.object({ id: z.number().int().positive(), full_name: z.string().min(1) })),
  repositories_removed: z.array(z.object({ id: z.number().int().positive(), full_name: z.string().min(1) })),
})

const maxWebhookBodyBytes = 1024 * 1024

export async function handleGitHubWebhook(input: {
  request: Request
  secret: string
  connections: GitHubConnectionStore
  events: ConnectionEventSink
}) {
  const deliveryId = requiredHeader(input.request, 'X-GitHub-Delivery')
  const eventName = requiredHeader(input.request, 'X-GitHub-Event')
  const bodyBytes = await readLimitedBody(input.request, maxWebhookBodyBytes)
  const signatureHeader = input.request.headers.get('X-Hub-Signature-256')
  await verifySignature(bodyBytes, input.secret, signatureHeader)
  const body = decodeBody(bodyBytes)
  const fingerprint = await sha256Hex(`${eventName}\n${signatureHeader}`)
  const change = lifecycleChange(eventName, deliveryId, fingerprint, body)
  if (!change) return

  const prepared = await input.connections.prepareLifecycleEvent(change)
  if (prepared.completed || !prepared.event) return
  await input.events.send(prepared.event)
  await input.connections.completeLifecycleEvent(deliveryId)
}

export async function deliverPendingGitHubConnectionEvents(input: {
  connections: GitHubConnectionStore
  events: ConnectionEventSink
}) {
  for (const event of await input.connections.pendingLifecycleEvents()) {
    await input.events.send(event)
    await input.connections.completeLifecycleEvent(event.id)
  }
}

async function verifySignature(body: Uint8Array, secret: string, header: string | null) {
  if (!header?.startsWith('sha256=')) throw invalidSignature()
  const signature = hexBytes(header.slice('sha256='.length))
  const key = await crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['verify'],
  )
  const valid = await crypto.subtle.verify('HMAC', key, signature, body)
  if (!valid) throw invalidSignature()
}

function lifecycleChange(
  eventName: string,
  deliveryId: string,
  fingerprint: string,
  body: string,
): GitHubLifecycleChange | undefined {
  if (eventName === 'installation') {
    const decoded = parseJson(body)
    const action = z.object({ action: z.string() }).parse(decoded).action
    if (!installationEventSchema.shape.action.options.includes(action as never)) return
    const payload = installationEventSchema.parse(decoded)
    const occurredAt =
      payload.action === 'suspend'
        ? githubTimestampSchema.parse(payload.installation.suspended_at)
        : payload.installation.updated_at
    const providerUpdatedAt = Date.parse(occurredAt)
    const type = {
      deleted: 'deleted',
      suspend: 'suspended',
      unsuspend: 'restored',
      new_permissions_accepted: 'authorityChanged',
    }[payload.action] as GitHubLifecycleChange['type']
    const scopes =
      type === 'authorityChanged'
        ? permissionsToScopes(z.record(z.string(), permissionAccessSchema).parse(payload.installation.permissions))
        : undefined
    return {
      deliveryId,
      fingerprint,
      type,
      installationId: payload.installation.id,
      occurredAt,
      providerUpdatedAt,
      ...(scopes ? { scopes } : {}),
    }
  }
  if (eventName === 'installation_repositories') {
    const decoded = parseJson(body)
    const action = z.object({ action: z.string() }).parse(decoded).action
    if (!repositoriesEventSchema.shape.action.options.includes(action as never)) return
    const payload = repositoriesEventSchema.parse(decoded)
    const providerUpdatedAt = Date.parse(payload.installation.updated_at)
    return {
      deliveryId,
      fingerprint,
      type: 'resourcesChanged',
      installationId: payload.installation.id,
      occurredAt: payload.installation.updated_at,
      providerUpdatedAt,
      repositorySelection: payload.repository_selection,
      repositoriesAdded: payload.repositories_added.map((repository) => ({
        id: repository.id,
        fullName: repository.full_name,
      })),
      repositoriesRemoved: payload.repositories_removed.map((repository) => ({
        id: repository.id,
        fullName: repository.full_name,
      })),
    }
  }
}

async function readLimitedBody(request: Request, limit: number) {
  const contentLength = request.headers.get('Content-Length')
  if (contentLength !== null && Number(contentLength) > limit) throw bodyTooLarge(limit)
  if (!request.body) return new Uint8Array()
  const reader = request.body.getReader()
  const chunks: Uint8Array[] = []
  let length = 0
  while (true) {
    const { done, value } = await reader.read()
    if (done) break
    length += value.byteLength
    if (length > limit) {
      await reader.cancel()
      throw bodyTooLarge(limit)
    }
    chunks.push(value)
  }
  const body = new Uint8Array(length)
  let offset = 0
  for (const chunk of chunks) {
    body.set(chunk, offset)
    offset += chunk.byteLength
  }
  return body
}

function decodeBody(body: Uint8Array) {
  try {
    return new TextDecoder('utf-8', { fatal: true, ignoreBOM: false }).decode(body)
  } catch {
    throw badRequest('The GitHub webhook body is not valid UTF-8.')
  }
}

function bodyTooLarge(limit: number) {
  return new HttpProblem(
    413,
    'urn:realmroot:adapter:webhook-body-too-large',
    'Content Too Large',
    `The GitHub webhook body exceeds ${limit} bytes.`,
  )
}

function parseJson(body: string) {
  try {
    return JSON.parse(body) as unknown
  } catch {
    throw badRequest('The GitHub webhook body is not valid JSON.')
  }
}

function requiredHeader(request: Request, name: string) {
  const value = request.headers.get(name)
  if (!value) throw badRequest(`${name} is required.`)
  return value
}

function hexBytes(value: string) {
  if (!/^[0-9a-f]{64}$/i.test(value)) throw invalidSignature()
  return Uint8Array.from(value.match(/.{2}/g) ?? [], (byte) => Number.parseInt(byte, 16))
}

function invalidSignature() {
  return new HttpProblem(
    401,
    'urn:realmroot:adapter:invalid-webhook-signature',
    'Unauthorized',
    'The GitHub webhook signature is missing or invalid.',
  )
}
