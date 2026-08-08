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
  request(request: Request, installationToken: string): Promise<Response>
}

export type GitHubUser = Readonly<{ id: number; login: string; name: string | null }>
export type GitHubInstallation = Readonly<{
  id: number
  accountLogin: string
  targetType: string
  permissions: GitHubPermissions
}>

export interface GitHubConnectionProvider {
  authorizationUrl(state: string): string
  exchangeUserCode(code: string): Promise<string>
  getUser(token: string): Promise<GitHubUser>
  listUserInstallations(token: string): Promise<GitHubInstallation[]>
  newInstallationUrl(state: string): Promise<string>
}
