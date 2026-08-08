export type GitHubRepository = Readonly<{
  id: number
  name: string
  fullName: string
  private: boolean
  htmlUrl: string
  owner: string
}>

export type GitHubIssue = Readonly<{
  id: number
  number: number
  title: string
  body: string | null
  state: string
  htmlUrl: string
}>

export type CreateIssueInput = Readonly<{
  installationId: number
  owner: string
  repository: string
  title: string
  body: string
}>

export interface GitHubProvider {
  listRepositories(
    installationId: number,
    page: number,
    perPage: number,
  ): Promise<{
    items: GitHubRepository[]
    total: number
  }>
  createIssue(input: CreateIssueInput): Promise<GitHubIssue>
}
