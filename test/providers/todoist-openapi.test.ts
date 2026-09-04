import { describe, expect, it } from 'vitest'
import { todoistOpenApi } from '../../src/providers/todoist/openapi.js'

describe('Todoist OpenAPI', () => {
  it('[spec: todoist-adapter/todoist-contract] publishes read-only resources with explicit OAuth authority', () => {
    const document = todoistOpenApi({
      resource: 'https://adapter.example/todoist',
      issuer: 'https://adapter.example/oauth/todoist',
    })
    expect(Object.keys(document.paths)).toEqual(['/projects', '/tasks'])
    for (const path of Object.values(document.paths)) {
      expect(path.get.security).toEqual([{ todoistTasks: ['tasks:read'] }])
      expect(path.get.operationId).toMatch(/^list/)
    }
    expect(document.components.securitySchemes.todoistTasks).toMatchObject({
      type: 'openIdConnect',
      openIdConnectUrl: 'https://adapter.example/.well-known/openid-configuration/oauth/todoist',
      'x-dpop-required': true,
    })
  })
})
