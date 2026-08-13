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

type AttributionMode = 'always' | 'when-present'

type RestAttributionRule = {
  behavior: 'agent-attribution'
  method: 'POST' | 'PATCH' | 'PUT'
  path: string
  pattern: RegExp
  body: AttributionMode
  reviewComments?: true
}

type GraphqlAttributionRule = {
  behavior: 'agent-attribution'
  method: 'POST'
  path: '/graphql'
  operation: 'mutation'
  field: string
  body: AttributionMode
  reviewComments?: true
}

const restAttributionRules = [
  {
    behavior: 'agent-attribution',
    method: 'POST',
    path: '/repos/{owner}/{repo}/issues',
    pattern: /^\/repos\/[^/]+\/[^/]+\/issues$/,
    body: 'always',
  },
  {
    behavior: 'agent-attribution',
    method: 'PATCH',
    path: '/repos/{owner}/{repo}/issues/{issue_number}',
    pattern: /^\/repos\/[^/]+\/[^/]+\/issues\/\d+$/,
    body: 'when-present',
  },
  {
    behavior: 'agent-attribution',
    method: 'POST',
    path: '/repos/{owner}/{repo}/issues/{issue_number}/comments',
    pattern: /^\/repos\/[^/]+\/[^/]+\/issues\/\d+\/comments$/,
    body: 'always',
  },
  {
    behavior: 'agent-attribution',
    method: 'PATCH',
    path: '/repos/{owner}/{repo}/issues/comments/{comment_id}',
    pattern: /^\/repos\/[^/]+\/[^/]+\/issues\/comments\/\d+$/,
    body: 'always',
  },
  {
    behavior: 'agent-attribution',
    method: 'POST',
    path: '/repos/{owner}/{repo}/pulls',
    pattern: /^\/repos\/[^/]+\/[^/]+\/pulls$/,
    body: 'always',
  },
  {
    behavior: 'agent-attribution',
    method: 'PATCH',
    path: '/repos/{owner}/{repo}/pulls/{pull_number}',
    pattern: /^\/repos\/[^/]+\/[^/]+\/pulls\/\d+$/,
    body: 'when-present',
  },
  {
    behavior: 'agent-attribution',
    method: 'POST',
    path: '/repos/{owner}/{repo}/pulls/{pull_number}/comments',
    pattern: /^\/repos\/[^/]+\/[^/]+\/pulls\/\d+\/comments$/,
    body: 'always',
  },
  {
    behavior: 'agent-attribution',
    method: 'POST',
    path: '/repos/{owner}/{repo}/pulls/{pull_number}/comments/{comment_id}/replies',
    pattern: /^\/repos\/[^/]+\/[^/]+\/pulls\/\d+\/comments\/\d+\/replies$/,
    body: 'always',
  },
  {
    behavior: 'agent-attribution',
    method: 'PATCH',
    path: '/repos/{owner}/{repo}/pulls/comments/{comment_id}',
    pattern: /^\/repos\/[^/]+\/[^/]+\/pulls\/comments\/\d+$/,
    body: 'always',
  },
  {
    behavior: 'agent-attribution',
    method: 'POST',
    path: '/repos/{owner}/{repo}/pulls/{pull_number}/reviews',
    pattern: /^\/repos\/[^/]+\/[^/]+\/pulls\/\d+\/reviews$/,
    body: 'when-present',
    reviewComments: true,
  },
  {
    behavior: 'agent-attribution',
    method: 'POST',
    path: '/repos/{owner}/{repo}/pulls/{pull_number}/reviews/{review_id}/events',
    pattern: /^\/repos\/[^/]+\/[^/]+\/pulls\/\d+\/reviews\/\d+\/events$/,
    body: 'when-present',
  },
  {
    behavior: 'agent-attribution',
    method: 'PUT',
    path: '/repos/{owner}/{repo}/pulls/{pull_number}/reviews/{review_id}',
    pattern: /^\/repos\/[^/]+\/[^/]+\/pulls\/\d+\/reviews\/\d+$/,
    body: 'always',
  },
  {
    behavior: 'agent-attribution',
    method: 'POST',
    path: '/repos/{owner}/{repo}/commits/{commit_sha}/comments',
    pattern: /^\/repos\/[^/]+\/[^/]+\/commits\/[^/]+\/comments$/,
    body: 'always',
  },
  {
    behavior: 'agent-attribution',
    method: 'PATCH',
    path: '/repos/{owner}/{repo}/comments/{comment_id}',
    pattern: /^\/repos\/[^/]+\/[^/]+\/comments\/\d+$/,
    body: 'always',
  },
  {
    behavior: 'agent-attribution',
    method: 'POST',
    path: '/repos/{owner}/{repo}/releases',
    pattern: /^\/repos\/[^/]+\/[^/]+\/releases$/,
    body: 'always',
  },
  {
    behavior: 'agent-attribution',
    method: 'PATCH',
    path: '/repos/{owner}/{repo}/releases/{release_id}',
    pattern: /^\/repos\/[^/]+\/[^/]+\/releases\/\d+$/,
    body: 'when-present',
  },
  {
    behavior: 'agent-attribution',
    method: 'POST',
    path: '/orgs/{org}/projectsV2/{project_number}/drafts',
    pattern: /^\/orgs\/[^/]+\/projectsV2\/\d+\/drafts$/,
    body: 'always',
  },
] as const satisfies readonly RestAttributionRule[]

const graphqlBodies = [
  { field: 'createIssue', body: 'always' },
  { field: 'updateIssue', body: 'when-present' },
  { field: 'addProjectV2DraftIssue', body: 'always' },
  { field: 'updateProjectV2DraftIssue', body: 'when-present' },
  { field: 'createProjectV2StatusUpdate', body: 'always' },
  { field: 'updateProjectV2StatusUpdate', body: 'when-present' },
  { field: 'createPullRequest', body: 'always' },
  { field: 'updatePullRequest', body: 'when-present' },
  { field: 'revertPullRequest', body: 'always' },
  { field: 'addComment', body: 'always' },
  { field: 'createDiscussion', body: 'always' },
  { field: 'updateDiscussion', body: 'when-present' },
  { field: 'addDiscussionComment', body: 'always' },
  { field: 'updateDiscussionComment', body: 'always' },
  { field: 'updateIssueComment', body: 'always' },
  { field: 'addPullRequestReview', body: 'when-present', reviewComments: true },
  { field: 'submitPullRequestReview', body: 'when-present' },
  { field: 'updatePullRequestReview', body: 'always' },
  { field: 'addPullRequestReviewComment', body: 'when-present' },
  { field: 'updatePullRequestReviewComment', body: 'always' },
  { field: 'addPullRequestReviewThread', body: 'always' },
  { field: 'addPullRequestReviewThreadReply', body: 'always' },
] as const satisfies readonly Pick<GraphqlAttributionRule, 'field' | 'body' | 'reviewComments'>[]

const graphqlAttributionRules: readonly GraphqlAttributionRule[] = graphqlBodies.map((rule) => ({
  behavior: 'agent-attribution' as const,
  method: 'POST' as const,
  path: '/graphql' as const,
  operation: 'mutation' as const,
  ...rule,
}))

const publishedAttributionTargets = [...restAttributionRules, ...graphqlAttributionRules].map((rule) => ({
  method: rule.method,
  path: rule.path,
  behavior: rule.behavior,
}))

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
  const restRule = restAttributionRules.find(
    (rule) => rule.method === input.request.method && rule.pattern.test(input.upstreamPath),
  )
  if (restRule) return transformRestRequest(input, restRule)
  const graphqlRules = graphqlAttributionRules.filter(
    (rule) => rule.method === input.request.method && rule.path === input.upstreamPath,
  )
  if (graphqlRules.length > 0) return transformGraphqlRequest(input, graphqlRules)
  return input.request.body
}

async function transformRestRequest(
  input: {
    request: Request
    principal: AgentPrincipal
    agentInfo: AgentInfoResolver
    requestId: string
  },
  rule: RestAttributionRule,
) {
  requireJson(input.request, 'This attributed GitHub operation requires a JSON request body.')
  const raw = await boundedBody(input.request)
  let json: unknown
  try {
    json = JSON.parse(raw)
  } catch {
    throw badRequest('The request body must be valid JSON.')
  }
  const body = attributedJsonSchema.parse(json)
  const hasBody = body.body !== undefined && body.body !== null
  const hasReviewComments = rule.reviewComments && Array.isArray(body.comments) && body.comments.length > 0
  if (rule.body === 'when-present' && !hasBody && !hasReviewComments) return raw
  const display = await input.agentInfo.resolve(input.principal)
  const transformed: Record<string, unknown> = {
    ...body,
  }
  if (rule.body === 'always' || hasBody) {
    transformed.body = attributedBody(body.body, input.principal, display, input.requestId)
  }
  if (rule.reviewComments) {
    transformed.comments = attributedReviewComments(body.comments, input.principal, display, input.requestId)
  }
  return JSON.stringify(transformed)
}

async function transformGraphqlRequest(
  input: {
    request: Request
    principal: AgentPrincipal
    agentInfo: AgentInfoResolver
    requestId: string
  },
  rules: readonly GraphqlAttributionRule[],
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

  const attributedMutationFields = new Map(
    rules.filter((rule) => rule.operation === operation.operation).map((rule) => [rule.field, rule]),
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
      const rule = attributedMutationFields.get(node.name.value)
      if (!rule) return
      const inputArgument = node.arguments?.find((argument) => argument.name.value === 'input')
      if (!inputArgument) throw badRequest(`${node.name.value} requires an input value for Agent attribution.`)
      if (inputArgument.value.kind === Kind.VARIABLE) {
        const name = inputArgument.value.name.value
        if (attributedVariables.has(name)) return
        const value = variables[name]
        if (!isObject(value)) throw badRequest(`${node.name.value} input variable must be an object.`)
        variables[name] = attributeGraphqlInput(value, rule, input.principal, display, input.requestId)
        attributedVariables.add(name)
        return
      }
      if (inputArgument.value.kind !== Kind.OBJECT) {
        throw badRequest(`${node.name.value} input must be an object or variable.`)
      }
      const objectValue = transformGraphqlObject(
        inputArgument.value,
        rule,
        node.name.value,
        variables,
        attributedVariables,
        input.principal,
        display,
        input.requestId,
      )
      return {
        ...node,
        arguments: node.arguments?.map((argument) =>
          argument === inputArgument
            ? {
                ...argument,
                value: objectValue,
              }
            : argument,
        ),
      }
    },
  })
  return JSON.stringify({ ...body, query: print(transformed), variables })
}

function attributeGraphqlInput(
  value: Record<string, unknown>,
  rule: GraphqlAttributionRule,
  principal: AgentPrincipal,
  display: Awaited<ReturnType<AgentInfoResolver['resolve']>>,
  requestId: string,
) {
  const transformed = { ...value }
  if (rule.body === 'always' || value.body !== undefined) {
    transformed.body = attributedBody(optionalBody(value.body), principal, display, requestId)
  }
  if (rule.reviewComments) {
    transformed.comments = attributedReviewComments(value.comments, principal, display, requestId)
  }
  return transformed
}

function attributedReviewComments(
  value: unknown,
  principal: AgentPrincipal,
  display: Awaited<ReturnType<AgentInfoResolver['resolve']>>,
  requestId: string,
) {
  if (value === undefined) return undefined
  if (!Array.isArray(value)) throw badRequest('GitHub review comments must be an array.')
  return value.map((comment) => {
    if (!isObject(comment)) throw badRequest('Each GitHub review comment must be an object.')
    return {
      ...comment,
      body: attributedBody(optionalBody(comment.body), principal, display, requestId),
    }
  })
}

function transformGraphqlObject(
  objectValue: Extract<ObjectFieldNode['value'], { kind: Kind.OBJECT }>,
  rule: GraphqlAttributionRule,
  operation: string,
  variables: Record<string, unknown>,
  attributedVariables: Set<string>,
  principal: AgentPrincipal,
  display: Awaited<ReturnType<AgentInfoResolver['resolve']>>,
  requestId: string,
) {
  const bodyField = objectValue.fields.find((field) => field.name.value === 'body')
  let fields = [...objectValue.fields]
  if (bodyField?.value.kind === Kind.VARIABLE) {
    const name = bodyField.value.name.value
    if (!attributedVariables.has(name)) {
      variables[name] = attributedBody(optionalBody(variables[name]), principal, display, requestId)
      attributedVariables.add(name)
    }
  } else if (bodyField || rule.body === 'always') {
    const value = bodyField ? graphqlString(bodyField, operation) : undefined
    const replacement = stringField('body', attributedBody(value, principal, display, requestId))
    fields = bodyField ? fields.map((field) => (field === bodyField ? replacement : field)) : [...fields, replacement]
  }
  if (rule.reviewComments) {
    fields = transformGraphqlReviewComments(
      fields,
      operation,
      variables,
      attributedVariables,
      principal,
      display,
      requestId,
    )
  }
  return { ...objectValue, fields }
}

function transformGraphqlReviewComments(
  fields: readonly ObjectFieldNode[],
  operation: string,
  variables: Record<string, unknown>,
  attributedVariables: Set<string>,
  principal: AgentPrincipal,
  display: Awaited<ReturnType<AgentInfoResolver['resolve']>>,
  requestId: string,
) {
  const commentsField = fields.find((field) => field.name.value === 'comments')
  if (!commentsField) return [...fields]
  if (commentsField.value.kind === Kind.VARIABLE) {
    const name = commentsField.value.name.value
    if (!attributedVariables.has(name)) {
      variables[name] = attributedReviewComments(variables[name], principal, display, requestId)
      attributedVariables.add(name)
    }
    return [...fields]
  }
  if (commentsField.value.kind !== Kind.LIST) throw badRequest(`${operation} comments must be a list or variable.`)
  const replacement: ObjectFieldNode = {
    ...commentsField,
    value: {
      ...commentsField.value,
      values: commentsField.value.values.map((comment) => {
        if (comment.kind !== Kind.OBJECT) throw badRequest(`${operation} review comments must be objects.`)
        const body = comment.fields.find((field) => field.name.value === 'body')
        if (!body) throw badRequest(`${operation} review comments require a body.`)
        if (body.value.kind === Kind.VARIABLE) {
          const name = body.value.name.value
          if (!attributedVariables.has(name)) {
            variables[name] = attributedBody(optionalBody(variables[name]), principal, display, requestId)
            attributedVariables.add(name)
          }
          return comment
        }
        return {
          ...comment,
          fields: comment.fields.map((field) =>
            field === body
              ? stringField('body', attributedBody(graphqlString(body, operation), principal, display, requestId))
              : field,
          ),
        }
      }),
    },
  }
  return fields.map((field) => (field === commentsField ? replacement : field))
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
