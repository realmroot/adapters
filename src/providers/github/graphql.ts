import { getOperationAST, Kind, parse } from 'graphql'
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

export type GitHubCreatePullRequest = z.infer<typeof createInputSchema> & { responseField: string }

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
