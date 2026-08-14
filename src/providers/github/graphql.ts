import { getOperationAST, Kind, parse, type SelectionSetNode } from 'graphql'
import { z } from 'zod'
import { badRequest, failedDependency } from '../../core/problem.js'
import type { GitHubProvider } from './types.js'

const requestSchema = z.object({
  query: z.string().min(1),
  variables: z.record(z.string(), z.unknown()).nullable().optional(),
  operationName: z.string().min(1).nullable().optional(),
})
const createInputSchema = z.object({
  repositoryId: z.string().min(1),
  baseRefName: z.string().min(1),
  headRefName: z.string().min(1),
  title: z.string().min(1),
  body: z.string().optional(),
  draft: z.boolean().optional(),
  maintainerCanModify: z.boolean().optional(),
})
const repositoryLookupSchema = z.object({
  data: z.object({ node: z.object({ nameWithOwner: z.string().min(3) }) }),
})
const pullRequestSchema = z.object({ node_id: z.string().min(1), html_url: z.url() })
const mergeInputSchema = z.object({
  pullRequestId: z.string().min(1),
  mergeMethod: z.enum(['MERGE', 'SQUASH', 'REBASE']),
  commitHeadline: z.string().optional(),
  commitBody: z.string().optional(),
  expectedHeadOid: z.string().optional(),
  clientMutationId: z.string().nullable().optional(),
})
const addCommentInputSchema = z.object({
  subjectId: z.string().min(1),
  body: z.string(),
  clientMutationId: z.string().nullable().optional(),
})
const pullRequestLookupSchema = z.object({
  data: z.object({
    node: z.object({
      number: z.number().int().positive(),
      repository: z.object({ nameWithOwner: z.string().min(3) }),
    }),
  }),
})
const mergedPullRequestSchema = z.object({ sha: z.string().min(1), merged: z.literal(true) })
const commentTargetSchema = z.object({
  data: z.object({
    node: z.object({
      number: z.number().int().positive(),
      repository: z.object({ nameWithOwner: z.string().min(3) }),
    }),
  }),
})
const issueCommentSchema = z.object({ node_id: z.string().min(1), html_url: z.url(), body: z.string() })

export type GitHubCreatePullRequest = z.infer<typeof createInputSchema> & { responseField: string }
export type GitHubMergePullRequest = z.infer<typeof mergeInputSchema> & { responseField: string }
export type GitHubAddComment = z.infer<typeof addCommentInputSchema> & {
  responseField: string
  responseSelection: SelectionSetNode | undefined
}

export function parseGitHubCreatePullRequest(body: BodyInit | null): GitHubCreatePullRequest | null {
  if (typeof body !== 'string') return null
  let request: z.infer<typeof requestSchema>
  let document: ReturnType<typeof parse>
  try {
    request = requestSchema.parse(JSON.parse(body))
    document = parse(request.query)
  } catch {
    return null
  }
  const operation = getOperationAST(document, request.operationName ?? undefined)
  if (operation?.operation !== 'mutation') return null
  const fields = operation.selectionSet.selections.filter((selection) => selection.kind === Kind.FIELD)
  if (fields.length !== 1 || fields[0]?.name.value !== 'createPullRequest') return null
  const field = fields[0]
  const inputArgument = field.arguments?.find((argument) => argument.name.value === 'input')
  if (!inputArgument || inputArgument.value.kind !== Kind.VARIABLE) {
    throw badRequest('GitHub createPullRequest compatibility requires one input variable.')
  }
  const input = createInputSchema.safeParse(request.variables?.[inputArgument.value.name.value])
  if (!input.success) throw badRequest('GitHub createPullRequest input is invalid.')
  return { ...input.data, responseField: field.alias?.value ?? field.name.value }
}

export function parseGitHubMergePullRequest(body: BodyInit | null): GitHubMergePullRequest | null {
  if (typeof body !== 'string') return null
  let request: z.infer<typeof requestSchema>
  let document: ReturnType<typeof parse>
  try {
    request = requestSchema.parse(JSON.parse(body))
    document = parse(request.query)
  } catch {
    return null
  }
  const operation = getOperationAST(document, request.operationName ?? undefined)
  if (operation?.operation !== 'mutation') return null
  const fields = operation.selectionSet.selections.filter((selection) => selection.kind === Kind.FIELD)
  if (fields.length !== 1 || fields[0]?.name.value !== 'mergePullRequest') return null
  const field = fields[0]
  const inputArgument = field.arguments?.find((argument) => argument.name.value === 'input')
  if (!inputArgument || inputArgument.value.kind !== Kind.VARIABLE) {
    throw badRequest('GitHub mergePullRequest compatibility requires one input variable.')
  }
  const input = mergeInputSchema.safeParse(request.variables?.[inputArgument.value.name.value])
  if (!input.success) throw badRequest('GitHub mergePullRequest input is invalid.')
  return { ...input.data, responseField: field.alias?.value ?? field.name.value }
}

export function parseGitHubAddComment(body: BodyInit | null): GitHubAddComment | null {
  if (typeof body !== 'string') return null
  let request: z.infer<typeof requestSchema>
  let document: ReturnType<typeof parse>
  try {
    request = requestSchema.parse(JSON.parse(body))
    document = parse(request.query)
  } catch {
    return null
  }
  const operation = getOperationAST(document, request.operationName ?? undefined)
  if (operation?.operation !== 'mutation') return null
  const fields = operation.selectionSet.selections.filter((selection) => selection.kind === Kind.FIELD)
  if (fields.length !== 1 || fields[0]?.name.value !== 'addComment') return null
  const field = fields[0]
  const inputArgument = field.arguments?.find((argument) => argument.name.value === 'input')
  if (!inputArgument || inputArgument.value.kind !== Kind.VARIABLE) {
    throw badRequest('GitHub addComment compatibility requires one input variable.')
  }
  const input = addCommentInputSchema.safeParse(request.variables?.[inputArgument.value.name.value])
  if (!input.success) throw badRequest('GitHub addComment input is invalid.')
  return {
    ...input.data,
    responseField: field.alias?.value ?? field.name.value,
    responseSelection: field.selectionSet,
  }
}

export async function resolveGitHubRepositoryName(input: {
  provider: GitHubProvider
  token: string
  apiOrigin: string
  repositoryId: string
}) {
  const response = await input.provider.request(
    new Request(new URL('/graphql', input.apiOrigin), {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        query: 'query RealmrootRepositoryName($id: ID!) { node(id: $id) { ... on Repository { nameWithOwner } } }',
        variables: { id: input.repositoryId },
      }),
    }),
    input.token,
  )
  const parsed = repositoryLookupSchema.safeParse(await response.json().catch(() => null))
  if (!response.ok || !parsed.success) throw failedDependency('GitHub could not resolve the pull request repository.')
  return parsed.data.data.node.nameWithOwner
}

export async function createGitHubPullRequestWithRest(input: {
  provider: GitHubProvider
  token: string
  apiOrigin: string
  nameWithOwner: string
  pullRequest: GitHubCreatePullRequest
}) {
  const response = await input.provider.request(
    new Request(new URL(`/repos/${input.nameWithOwner}/pulls`, input.apiOrigin), {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        title: input.pullRequest.title,
        head: input.pullRequest.headRefName,
        base: input.pullRequest.baseRefName,
        ...(input.pullRequest.body === undefined ? {} : { body: input.pullRequest.body }),
        ...(input.pullRequest.draft === undefined ? {} : { draft: input.pullRequest.draft }),
        ...(input.pullRequest.maintainerCanModify === undefined
          ? {}
          : { maintainer_can_modify: input.pullRequest.maintainerCanModify }),
      }),
    }),
    input.token,
  )
  if (!response.ok) return response
  const parsed = pullRequestSchema.safeParse(await response.json().catch(() => null))
  if (!parsed.success) throw failedDependency('GitHub returned an invalid pull request response.')
  const headers = new Headers(response.headers)
  headers.delete('content-length')
  headers.delete('content-encoding')
  headers.set('content-type', 'application/json; charset=utf-8')
  return new Response(
    JSON.stringify({
      data: {
        [input.pullRequest.responseField]: {
          pullRequest: { id: parsed.data.node_id, url: parsed.data.html_url },
        },
      },
    }),
    { status: 200, headers },
  )
}

export async function resolveGitHubPullRequestTarget(input: {
  provider: GitHubProvider
  token: string
  apiOrigin: string
  pullRequestId: string
}) {
  const response = await input.provider.request(
    new Request(new URL('/graphql', input.apiOrigin), {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        query:
          'query RealmrootPullRequestTarget($id: ID!) { node(id: $id) { ... on PullRequest { number repository { nameWithOwner } } } }',
        variables: { id: input.pullRequestId },
      }),
    }),
    input.token,
  )
  const parsed = pullRequestLookupSchema.safeParse(await response.json().catch(() => null))
  if (!response.ok || !parsed.success) throw failedDependency('GitHub could not resolve the pull request target.')
  return {
    nameWithOwner: parsed.data.data.node.repository.nameWithOwner,
    number: parsed.data.data.node.number,
  }
}

export async function resolveGitHubCommentTarget(input: {
  provider: GitHubProvider
  token: string
  apiOrigin: string
  subjectId: string
}) {
  const response = await input.provider.request(
    new Request(new URL('/graphql', input.apiOrigin), {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        query: `query RealmrootCommentTarget($id: ID!) {
          node(id: $id) {
            ... on Issue { number repository { nameWithOwner } }
            ... on PullRequest { number repository { nameWithOwner } }
          }
        }`,
        variables: { id: input.subjectId },
      }),
    }),
    input.token,
  )
  const parsed = commentTargetSchema.safeParse(await response.json().catch(() => null))
  if (!response.ok || !parsed.success) throw failedDependency('GitHub could not resolve the comment target.')
  return {
    nameWithOwner: parsed.data.data.node.repository.nameWithOwner,
    number: parsed.data.data.node.number,
  }
}

export async function createGitHubCommentWithRest(input: {
  provider: GitHubProvider
  token: string
  apiOrigin: string
  nameWithOwner: string
  number: number
  comment: GitHubAddComment
}) {
  const response = await input.provider.request(
    new Request(new URL(`/repos/${input.nameWithOwner}/issues/${input.number}/comments`, input.apiOrigin), {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ body: input.comment.body }),
    }),
    input.token,
  )
  if (!response.ok) return response
  const parsed = issueCommentSchema.safeParse(await response.json().catch(() => null))
  if (!parsed.success) throw failedDependency('GitHub returned an invalid comment response.')
  const headers = new Headers(response.headers)
  headers.delete('content-length')
  headers.delete('content-encoding')
  headers.set('content-type', 'application/json; charset=utf-8')
  return new Response(
    JSON.stringify({
      data: {
        [input.comment.responseField]: projectSelection(input.comment.responseSelection, {
          clientMutationId: input.comment.clientMutationId ?? null,
          subject: { id: input.comment.subjectId },
          commentEdge: { node: { id: parsed.data.node_id, url: parsed.data.html_url, body: parsed.data.body } },
          timelineEdge: null,
        }),
      },
    }),
    { status: 200, headers },
  )
}

function projectSelection(selectionSet: SelectionSetNode | undefined, source: Record<string, unknown>) {
  if (!selectionSet) return {}
  const projected: Record<string, unknown> = {}
  for (const selection of selectionSet.selections) {
    if (selection.kind === Kind.FRAGMENT_SPREAD) continue
    if (selection.kind === Kind.INLINE_FRAGMENT) {
      Object.assign(projected, projectSelection(selection.selectionSet, source))
      continue
    }
    const value = source[selection.name.value]
    projected[selection.alias?.value ?? selection.name.value] =
      selection.selectionSet && isRecord(value) ? projectSelection(selection.selectionSet, value) : (value ?? null)
  }
  return projected
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

export async function mergeGitHubPullRequestWithRest(input: {
  provider: GitHubProvider
  token: string
  apiOrigin: string
  nameWithOwner: string
  number: number
  pullRequest: GitHubMergePullRequest
}) {
  const response = await input.provider.request(
    new Request(new URL(`/repos/${input.nameWithOwner}/pulls/${input.number}/merge`, input.apiOrigin), {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        merge_method: input.pullRequest.mergeMethod.toLowerCase(),
        ...(input.pullRequest.commitHeadline === undefined ? {} : { commit_title: input.pullRequest.commitHeadline }),
        ...(input.pullRequest.commitBody === undefined ? {} : { commit_message: input.pullRequest.commitBody }),
        ...(input.pullRequest.expectedHeadOid === undefined ? {} : { sha: input.pullRequest.expectedHeadOid }),
      }),
    }),
    input.token,
  )
  if (!response.ok) return response
  const parsed = mergedPullRequestSchema.safeParse(await response.json().catch(() => null))
  if (!parsed.success) throw failedDependency('GitHub returned an invalid pull request merge response.')
  const headers = new Headers(response.headers)
  headers.delete('content-length')
  headers.delete('content-encoding')
  headers.set('content-type', 'application/json; charset=utf-8')
  return new Response(
    JSON.stringify({
      data: {
        [input.pullRequest.responseField]: {
          clientMutationId: input.pullRequest.clientMutationId ?? null,
        },
      },
    }),
    { status: 200, headers },
  )
}
