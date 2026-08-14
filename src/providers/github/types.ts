export type GitHubPermissionAccess = 'read' | 'write' | 'admin'
export type GitHubPermissions = Readonly<Record<string, GitHubPermissionAccess>>

export type GitHubInstallationTokenRequest = Readonly<{
  installationId: number
  permissions: GitHubPermissions
  repositories?: readonly string[]
}>

export interface GitHubProvider {
  appPermissions(): Promise<GitHubPermissions>
  openApiDocument(): Promise<Response>
  installationToken(input: GitHubInstallationTokenRequest): Promise<string>
  request(request: Request, token: string, mode?: 'api' | 'git'): Promise<Response>
}

export type GitHubUser = Readonly<{ id: number; login: string; name: string | null }>
export type GitHubUserToken = Readonly<{
  accessToken: string
  refreshToken: string | null
  expiresAt: number | null
  refreshTokenExpiresAt: number | null
}>
export type GitHubUserCredential = GitHubUserToken &
  Readonly<{
    subject: string
    credentialVersion: number
  }>
export type GitHubInstallation = Readonly<{
  id: number
  htmlUrl: string
  accountLogin: string
  targetType: string
  permissions: GitHubPermissions
  repositorySelection: 'all' | 'selected'
  repositories: readonly GitHubRepository[]
  updatedAt: string
}>

export type GitHubRepository = Readonly<{ id: number; fullName: string }>

export interface GitHubConnectionProvider {
  authorizationUrl(state: string): string
  exchangeUserCode(code: string): Promise<GitHubUserToken>
  refreshUserToken(refreshToken: string): Promise<GitHubUserToken>
  getUser(token: string): Promise<GitHubUser>
  listUserInstallations(token: string): Promise<GitHubInstallation[]>
  newInstallationUrl(state: string): Promise<string>
  permissionUpdateUrl(installation: GitHubInstallation): string
}
