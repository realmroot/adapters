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

export type GitHubUser = Readonly<{ id: number; login: string; name: string | null }>
export type GitHubInstallation = Readonly<{ id: number; accountLogin: string; targetType: string }>

export interface GitHubConnectionProvider {
  authorizationUrl(state: string): string
  exchangeUserCode(code: string): Promise<string>
  getUser(token: string): Promise<GitHubUser>
  listUserInstallations(token: string): Promise<GitHubInstallation[]>
  newInstallationUrl(state: string): Promise<string>
}
