import type { AdapterModule } from '../core/adapter.js'
import { context7Definition } from './context7/definition.js'
import { fastioDefinition } from './fastio/definition.js'
import {
  createCloudflareModules,
  createGitHubModules,
  createLinearModules,
  createManagedModules,
  type ProviderRuntime,
} from './runtime.js'
import { search1ApiDefinition } from './search1api/definition.js'
import { todoistDefinition } from './todoist/definition.js'

export type ProviderRegistration = {
  id: string
  name: string
  category: string
  description: string
  capabilities: readonly string[]
  maturity: string
  color: string
  mark: string
  requiredSecrets: readonly (keyof Env)[]
  create(runtime: ProviderRuntime): Promise<AdapterModule[]>
}

export const providerRegistry: readonly ProviderRegistration[] = [
  {
    id: 'github',
    name: 'GitHub',
    category: 'Development',
    description: 'Repositories, pull requests, issues, and code. Give your Agent a place on your development team.',
    capabilities: ['Repositories', 'Pull requests', 'Git'],
    maturity: 'Alpha',
    color: '#d8dee9',
    mark: 'GH',
    requiredSecrets: ['GITHUB_APP_ID', 'GITHUB_PRIVATE_KEY', 'GITHUB_CLIENT_ID', 'GITHUB_CLIENT_SECRET'],
    create: createGitHubModules,
  },
  {
    id: 'linear',
    name: 'Linear',
    category: 'Productivity',
    description: 'Keep projects moving with issues, teams, and workflows, with visible Agent attribution.',
    capabilities: ['Issues', 'Projects', 'Teams'],
    maturity: 'Experimental',
    color: '#a69cff',
    mark: 'L',
    requiredSecrets: ['LINEAR_CLIENT_ID', 'LINEAR_CLIENT_SECRET', 'LINEAR_CREDENTIAL_ENCRYPTION_KEY'],
    create: createLinearModules,
  },
  {
    id: 'cloudflare',
    name: 'Cloudflare',
    category: 'Infrastructure',
    description: 'Bring Agent access to your infrastructure, from Workers and DNS to databases and storage.',
    capabilities: ['Workers', 'DNS', 'Storage'],
    maturity: 'Experimental',
    color: '#ffac69',
    mark: 'CF',
    requiredSecrets: ['CLOUDFLARE_CLIENT_ID', 'CLOUDFLARE_CLIENT_SECRET', 'CLOUDFLARE_CREDENTIAL_ENCRYPTION_KEY'],
    create: createCloudflareModules,
  },
  {
    id: context7Definition.id,
    name: context7Definition.name,
    category: 'Knowledge',
    description: 'Put current library documentation and relevant code examples within your Agent’s reach.',
    capabilities: ['Documentation', 'Libraries'],
    maturity: 'Experimental',
    color: '#91ddb0',
    mark: 'C7',
    requiredSecrets: ['CONTEXT7_CREDENTIAL_ENCRYPTION_KEY'],
    create: (runtime) =>
      createManagedModules(context7Definition, runtime.env.CONTEXT7_CREDENTIAL_ENCRYPTION_KEY, runtime),
  },
  {
    id: todoistDefinition.id,
    name: todoistDefinition.name,
    category: 'Productivity',
    description: 'Let your Agent read your tasks and projects to understand what needs your attention.',
    capabilities: ['Tasks · read only', 'Projects'],
    maturity: 'Experimental',
    color: '#ff9694',
    mark: 'T',
    requiredSecrets: ['TODOIST_CREDENTIAL_ENCRYPTION_KEY'],
    create: (runtime) =>
      createManagedModules(todoistDefinition, runtime.env.TODOIST_CREDENTIAL_ENCRYPTION_KEY, runtime),
  },
  {
    id: search1ApiDefinition.id,
    name: search1ApiDefinition.name,
    category: 'Knowledge',
    description: 'Search the web and retrieve information through one connected account.',
    capabilities: ['Web search', 'Information'],
    maturity: 'Experimental',
    color: '#89b9ff',
    mark: 'S1',
    requiredSecrets: ['SEARCH1API_CREDENTIAL_ENCRYPTION_KEY'],
    create: (runtime) =>
      createManagedModules(search1ApiDefinition, runtime.env.SEARCH1API_CREDENTIAL_ENCRYPTION_KEY, runtime),
  },
  {
    id: fastioDefinition.id,
    name: fastioDefinition.name,
    category: 'Storage',
    description: 'Bring shared workspaces and files into your Agent’s workflow.',
    capabilities: ['Workspaces', 'Files'],
    maturity: 'Experimental',
    color: '#f1cb84',
    mark: 'F',
    requiredSecrets: ['FASTIO_CREDENTIAL_ENCRYPTION_KEY'],
    create: (runtime) => createManagedModules(fastioDefinition, runtime.env.FASTIO_CREDENTIAL_ENCRYPTION_KEY, runtime),
  },
]

export function providerDirectory(env: Env, registrations: readonly ProviderRegistration[] = providerRegistry) {
  return registrations.map(({ requiredSecrets, create: _create, ...display }) => ({
    ...display,
    enabled: Boolean(env.ADAPTER_OAUTH_SIGNING_PRIVATE_JWK) && requiredSecrets.every((key) => Boolean(env[key])),
  }))
}

export async function createProviderModules(
  runtime: ProviderRuntime,
  registrations: readonly ProviderRegistration[] = providerRegistry,
) {
  const modules: AdapterModule[] = []
  for (const registration of registrations) modules.push(...(await registration.create(runtime)))
  return modules
}
