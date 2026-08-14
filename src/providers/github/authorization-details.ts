export const GITHUB_INSTALLATION_AUTHORIZATION_DETAIL_TYPE =
  'https://adapters.realmroot.dev/authorization-details/github-installation'

export type GitHubInstallationAuthorizationContext = {
  installationId: number
  accountLogin: string
  targetType: string
  repositorySelection: 'all' | 'selected'
  repositories: readonly { id: number; fullName: string }[]
}

export function githubInstallationAuthorizationDetail(context: GitHubInstallationAuthorizationContext) {
  return {
    type: GITHUB_INSTALLATION_AUTHORIZATION_DETAIL_TYPE,
    installation_id: String(context.installationId),
    account_login: context.accountLogin,
    target_type: context.targetType,
    repository_selection: context.repositorySelection,
    ...(context.repositorySelection === 'selected'
      ? {
          repositories: context.repositories.map((repository) => ({
            id: String(repository.id),
            full_name: repository.fullName,
          })),
        }
      : {}),
  }
}

export function githubInstallationAuthorizationDetailDisplay(context: GitHubInstallationAuthorizationContext) {
  return {
    label: context.accountLogin,
    description: `${context.targetType} GitHub App installation`,
    metadata: {
      installation_id: String(context.installationId),
      target_type: context.targetType,
      repository_selection: context.repositorySelection,
    },
  }
}
