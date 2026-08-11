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
import { attributedBody } from '../../core/attribution.js'
import { badRequest } from '../../core/problem.js'
import type { AgentPrincipal } from '../../core/realmroot-auth.js'

const maxAttributedRequestBytes = 70_000
const attributedJsonSchema = z.object({ body: z.string().max(65_536).optional() }).passthrough()
const graphqlRequestSchema = z
  .object({
    query: z.string().min(1),
    variables: z.record(z.string(), z.unknown()).nullable().optional(),
    operationName: z.string().min(1).nullable().optional(),
  })
  .passthrough()

const attributionRules = [
  {
    behavior: 'agent-attribution',
    rest: {
      method: 'POST',
      path: '/repos/{owner}/{repo}/issues',
      pattern: /^\/repos\/[^/]+\/[^/]+\/issues$/,
    },
    graphql: { method: 'POST', path: '/graphql', operation: 'mutation', field: 'createIssue' },
  },
  {
    behavior: 'agent-attribution',
    rest: {
      method: 'POST',
      path: '/repos/{owner}/{repo}/issues/{issue_number}/comments',
      pattern: /^\/repos\/[^/]+\/[^/]+\/issues\/\d+\/comments$/,
    },
  },
  {
    behavior: 'agent-attribution',
    rest: {
      method: 'POST',
      path: '/repos/{owner}/{repo}/pulls/{pull_number}/comments',
      pattern: /^\/repos\/[^/]+\/[^/]+\/pulls\/\d+\/comments$/,
    },
  },
] as const

const publishedAttributionTargets = attributionRules.flatMap((rule) => {
  const targets: { method: string; path: string; behavior: string }[] = [
    { method: rule.rest.method, path: rule.rest.path, behavior: rule.behavior },
  ]
  if ('graphql' in rule) {
    targets.push({ method: rule.graphql.method, path: rule.graphql.path, behavior: rule.behavior })
  }
  return targets
})

export const githubAttributionTransformations = [
  ...new Map(publishedAttributionTargets.map((target) => [`${target.method} ${target.path}`, target])).values(),
]

export async function transformGitHubRequest(input: {
  request: Request
  upstreamPath: string
  principal: AgentPrincipal
  agentInfo: AgentInfoResolver
  requestId: string
}) {
  const restRule = attributionRules.find(
    (rule) => rule.rest.method === input.request.method && rule.rest.pattern.test(input.upstreamPath),
  )
  if (restRule) return transformRestRequest(input)
  const graphqlRules = attributionRules.flatMap((rule) =>
    'graphql' in rule && rule.graphql.method === input.request.method && rule.graphql.path === input.upstreamPath
      ? [rule.graphql]
      : [],
  )
  if (graphqlRules.length > 0) return transformGraphqlRequest(input, graphqlRules)
  return input.request.body
}

async function transformRestRequest(input: {
  request: Request
  principal: AgentPrincipal
  agentInfo: AgentInfoResolver
  requestId: string
}) {
  requireJson(input.request, 'This attributed GitHub operation requires a JSON request body.')
  const raw = await boundedBody(input.request)
  let json: unknown
  try {
    json = JSON.parse(raw)
  } catch {
    throw badRequest('The request body must be valid JSON.')
  }
  const body = attributedJsonSchema.parse(json)
  const display = await input.agentInfo.resolve(input.principal)
  return JSON.stringify({
    ...body,
    body: attributedBody(body.body, input.principal, display, input.requestId),
  })
}

async function transformGraphqlRequest(
  input: {
    request: Request
    principal: AgentPrincipal
    agentInfo: AgentInfoResolver
    requestId: string
  },
  rules: readonly { operation: 'mutation'; field: string }[],
) {
  if (!input.request.headers.get('content-type')?.toLowerCase().startsWith('application/json')) {
    return input.request.body
  }
  const raw = await boundedBody(input.request)
  let body: z.infer<typeof graphqlRequestSchema>
  let document: DocumentNode
  try {
    body = graphqlRequestSchema.parse(JSON.parse(raw))
    document = parse(body.query)
  } catch {
    return raw
  }
  const operation = getOperationAST(document, body.operationName ?? undefined)
  if (operation?.operation !== 'mutation') return raw

  const attributedMutationFields = new Set(
    rules.filter((rule) => rule.operation === operation.operation).map((rule) => rule.field),
  )
  const fields = collectFields(operation.selectionSet, document)
  const attributedFields = new Set([...fields].filter((field) => attributedMutationFields.has(field.name.value)))
  if (attributedFields.size === 0) return raw

  const display = await input.agentInfo.resolve(input.principal)
  const variables = { ...(body.variables ?? {}) }
  const attributedVariables = new Set<string>()
  const transformed = visit(document, {
    Field(node) {
      if (!attributedFields.has(node)) return
      const inputArgument = node.arguments?.find((argument) => argument.name.value === 'input')
      if (!inputArgument) throw badRequest(`${node.name.value} requires an input value for Agent attribution.`)
      if (inputArgument.value.kind === Kind.VARIABLE) {
        const name = inputArgument.value.name.value
        if (attributedVariables.has(name)) return
        const value = variables[name]
        if (!isObject(value)) throw badRequest(`${node.name.value} input variable must be an object.`)
        variables[name] = {
          ...value,
          body: attributedBody(optionalBody(value.body), input.principal, display, input.requestId),
        }
        attributedVariables.add(name)
        return
      }
      if (inputArgument.value.kind !== Kind.OBJECT) {
        throw badRequest(`${node.name.value} input must be an object or variable.`)
      }
      const objectValue = inputArgument.value
      const bodyField = objectValue.fields.find((field) => field.name.value === 'body')
      if (bodyField?.value.kind === Kind.VARIABLE) {
        const name = bodyField.value.name.value
        if (!attributedVariables.has(name)) {
          variables[name] = attributedBody(optionalBody(variables[name]), input.principal, display, input.requestId)
          attributedVariables.add(name)
        }
        return
      }
      const value = bodyField ? graphqlString(bodyField, node.name.value) : undefined
      const replacement = stringField('body', attributedBody(value, input.principal, display, input.requestId))
      return {
        ...node,
        arguments: node.arguments?.map((argument) =>
          argument === inputArgument
            ? {
                ...argument,
                value: {
                  ...objectValue,
                  fields: bodyField
                    ? objectValue.fields.map((field) => (field === bodyField ? replacement : field))
                    : [...objectValue.fields, replacement],
                },
              }
            : argument,
        ),
      }
    },
  })
  return JSON.stringify({ ...body, query: print(transformed), variables })
}

function collectFields(selectionSet: SelectionSetNode, document: DocumentNode) {
  const fragments = new Map(
    document.definitions
      .filter((definition): definition is FragmentDefinitionNode => definition.kind === Kind.FRAGMENT_DEFINITION)
      .map((definition) => [definition.name.value, definition]),
  )
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
        if (fragment) collect(fragment.selectionSet)
      }
    }
  }
}

function optionalBody(value: unknown) {
  if (value === undefined || value === null) return undefined
  if (typeof value === 'string') return value
  throw badRequest('GitHub Agent attribution body must be a string.')
}

function graphqlString(field: ObjectFieldNode, operation: string) {
  if (field.value.kind === Kind.NULL) return undefined
  if (field.value.kind === Kind.STRING) return field.value.value
  throw badRequest(`${operation} body must be a string or variable.`)
}

function stringField(name: string, value: string): ObjectFieldNode {
  return {
    kind: Kind.OBJECT_FIELD,
    name: { kind: Kind.NAME, value: name },
    value: { kind: Kind.STRING, value },
  }
}

function requireJson(request: Request, message: string) {
  if (!request.headers.get('content-type')?.toLowerCase().startsWith('application/json')) throw badRequest(message)
}

async function boundedBody(request: Request) {
  const declared = Number(request.headers.get('content-length'))
  if (Number.isFinite(declared) && declared > maxAttributedRequestBytes) throw requestTooLarge()
  if (!request.body) throw badRequest('The attributed GitHub request body is required.')
  const reader = request.body.getReader()
  const chunks: Uint8Array[] = []
  let size = 0
  while (true) {
    const { done, value } = await reader.read()
    if (done) break
    size += value.byteLength
    if (size > maxAttributedRequestBytes) {
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

function requestTooLarge() {
  return badRequest(`Attributed GitHub requests may not exceed ${maxAttributedRequestBytes} bytes.`)
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}
