import type { LinearScope } from './scopes.js'

export type LinearToken = Readonly<{
  accessToken: string
  refreshToken: string
  expiresAt: number
  scopes: readonly LinearScope[]
}>

export type LinearViewer = Readonly<{
  user: { id: string; name: string; email: string | null }
  workspace: { id: string; name: string; urlKey: string; logoUrl: string | null }
}>

export interface LinearProvider {
  authorizationUrl(input: { actor: 'user' | 'app'; state: string; scopes: readonly LinearScope[] }): string
  exchangeCode(code: string): Promise<LinearToken>
  refresh(refreshToken: string): Promise<LinearToken>
  revoke(token: string): Promise<void>
  viewer(accessToken: string): Promise<LinearViewer>
  request(request: Request, accessToken: string): Promise<Response>
}

export interface LinearCredentialCipher {
  seal(value: string, context: string): Promise<string>
  open(value: string, context: string): Promise<string>
}
