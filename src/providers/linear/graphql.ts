import {
  type DocumentNode,
  type FieldNode,
  type FragmentDefinitionNode,
  getOperationAST,
  Kind,
  type ObjectFieldNode,
  parse,
  print,
  type SelectionSetNode,
  visit,
} from 'graphql'
import { z } from 'zod'
import type { AgentInfoResolver } from '../../core/agent-info.js'
import { badRequest, forbidden } from '../../core/problem.js'
import type { AgentPrincipal } from '../../core/realmroot-auth.js'
import type { LinearScope } from './scopes.js'

const maxGraphqlRequestBytes = 512 * 1024
const requestSchema = z.looseObject({
  query: z.string().min(1),
  variables: z.record(z.string(), z.unknown()).nullable().optional(),
  operationName: z.string().min(1).nullable().optional(),
})
const identityFields = new Set(['createAsUser', 'displayIconUrl'])
const attributedMutations = new Set(['issueCreate', 'commentCreate'])

export async function prepareLinearGraphqlRequest(input: {
  request: Request
  principal: AgentPrincipal
  agentInfo: AgentInfoResolver
}) {
  if (!input.request.headers.get('content-type')?.toLowerCase().startsWith('application/json')) {
    throw badRequest('Linear GraphQL requests require an application/json body.')
  }
  const raw = await boundedBody(input.request)
  let body: z.infer<typeof requestSchema>
  let document: DocumentNode
  try {
    body = requestSchema.parse(JSON.parse(raw))
    document = parse(body.query)
  } catch {
    throw badRequest('The Linear GraphQL request body or document is invalid.')
  }
  const operation = getOperationAST(document, body.operationName ?? undefined)
  if (!operation) throw badRequest('Select exactly one Linear GraphQL operation.')
  if (operation.operation === 'subscription') throw badRequest('Linear GraphQL subscriptions are not supported.')

  const fragments = new Map(
    document.definitions
      .filter((definition): definition is FragmentDefinitionNode => definition.kind === Kind.FRAGMENT_DEFINITION)
      .map((definition) => [definition.name.value, definition]),
  )
  const fields = collectFields(operation.selectionSet, fragments)
  for (const field of fields) requireFieldScope(operation.operation, field.name.value, input.principal.scopes)

  const attributed = new Set([...fields].filter((field) => attributedMutations.has(field.name.value)))
  if (attributed.size === 0) return raw

  const display = await input.agentInfo.resolve(input.principal)
  const variables = { ...(body.variables ?? {}) }
  const transformed = visit(document, {
    Field(node) {
      if (!attributed.has(node)) return
      const inputArgument = node.arguments?.find((argument) => argument.name.value === 'input')
      if (!inputArgument) throw badRequest(`${node.name.value} requires an input value for Agent display attribution.`)
      if (inputArgument.value.kind === Kind.VARIABLE) {
        const name = inputArgument.value.name.value
        const value = variables[name]
        if (!isObject(value)) throw badRequest(`${node.name.value} input variable must be an object.`)
        rejectSuppliedIdentity(value)
        variables[name] = { ...value, createAsUser: display.name, displayIconUrl: display.picture }
        return
      }
      if (inputArgument.value.kind !== Kind.OBJECT) {
        throw badRequest(`${node.name.value} input must be an object or variable.`)
      }
      const objectValue = inputArgument.value
      const supplied = new Set(objectValue.fields.map((field) => field.name.value))
      if ([...identityFields].some((field) => supplied.has(field))) throw reservedIdentity()
      return {
        ...node,
        arguments: node.arguments?.map((argument) =>
          argument === inputArgument
            ? {
                ...argument,
                value: {
                  ...objectValue,
                  fields: [
                    ...objectValue.fields,
                    stringField('createAsUser', display.name),
                    stringField('displayIconUrl', display.picture),
                  ],
                },
              }
            : argument,
        ),
      }
    },
  })
  return JSON.stringify({ ...body, query: print(transformed), variables })
}

function collectFields(selectionSet: SelectionSetNode, fragments: Map<string, FragmentDefinitionNode>) {
  const fields = new Set<FieldNode>()
  const visitedFragments = new Set<string>()
  collect(selectionSet)
  return fields

  function collect(current: SelectionSetNode) {
    for (const selection of current.selections) {
      if (selection.kind === Kind.FIELD) fields.add(selection)
      else if (selection.kind === Kind.INLINE_FRAGMENT) collect(selection.selectionSet)
      else if (!visitedFragments.has(selection.name.value)) {
        visitedFragments.add(selection.name.value)
        const fragment = fragments.get(selection.name.value)
        if (!fragment) throw badRequest(`Linear GraphQL fragment ${selection.name.value} was not found.`)
        collect(fragment.selectionSet)
      }
    }
  }
}

function requireFieldScope(
  operation: 'query' | 'mutation' | 'subscription',
  field: string,
  granted: ReadonlySet<string>,
) {
  const alternatives = fieldScopes(operation, field)
  if (!alternatives.some((scope) => granted.has(scope))) {
    throw forbidden(`Linear operation ${field} requires ${alternatives.join(' or ')}.`)
  }
}

function fieldScopes(operation: 'query' | 'mutation' | 'subscription', field: string): readonly LinearScope[] {
  if (operation === 'query') {
    if (/^customer/i.test(field)) return ['customer:read']
    if (/^initiative/i.test(field)) return ['initiative:read']
    return ['read']
  }
  if (field === 'issueCreate') return ['issues:create', 'write']
  if (field === 'commentCreate') return ['comments:create', 'write']
  if (/^timeSchedule/i.test(field)) return ['timeSchedule:write']
  if (/^customer/i.test(field)) return ['customer:write']
  if (/^initiative/i.test(field)) return ['initiative:write']
  return ['write']
}

async function boundedBody(request: Request) {
  const declared = Number(request.headers.get('content-length'))
  if (Number.isFinite(declared) && declared > maxGraphqlRequestBytes) throw requestTooLarge()
  if (!request.body) throw badRequest('Linear GraphQL request body is required.')
  const reader = request.body.getReader()
  const chunks: Uint8Array[] = []
  let size = 0
  while (true) {
    const { done, value } = await reader.read()
    if (done) break
    size += value.byteLength
    if (size > maxGraphqlRequestBytes) {
      await reader.cancel()
      throw requestTooLarge()
    }
    chunks.push(value)
  }
  const bytes = new Uint8Array(size)
  let offset = 0
  for (const chunk of chunks) {
    bytes.set(chunk, offset)
    offset += chunk.byteLength
  }
  return new TextDecoder().decode(bytes)
}

function rejectSuppliedIdentity(value: Record<string, unknown>) {
  if ([...identityFields].some((field) => Object.hasOwn(value, field))) throw reservedIdentity()
}

function reservedIdentity() {
  return badRequest('Linear Agent display identity is reserved for the authenticated Realmroot Agent.')
}

function requestTooLarge() {
  return badRequest(`Linear GraphQL requests may not exceed ${maxGraphqlRequestBytes} bytes.`)
}

function stringField(name: string, value: string): ObjectFieldNode {
  return {
    kind: Kind.OBJECT_FIELD,
    name: { kind: Kind.NAME, value: name },
    value: { kind: Kind.STRING, value },
  }
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}
