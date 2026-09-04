import { describe, expect, it } from 'vitest'
import { context7OpenApi } from '../../src/providers/context7/openapi.js'

describe('Context7 OpenAPI', () => {
  it('[spec: context7-adapter/context7-contract] publishes noun-based resources with explicit OAuth authority', () => {
    const document = context7OpenApi({
      resource: 'https://adapter.example/context7',
      issuer: 'https://adapter.example/oauth/context7',
    })
    expect(Object.keys(document.paths)).toEqual(['/libraries', '/documentation'])
    for (const path of Object.values(document.paths)) {
      expect(path.get.security).toEqual([{ context7Documentation: ['documentation:read'] }])
      expect(path.get.operationId).not.toMatch(/search|query|execute/i)
    }
    expect(document.components.securitySchemes.context7Documentation).toMatchObject({
      type: 'openIdConnect',
      openIdConnectUrl: 'https://adapter.example/.well-known/openid-configuration/oauth/context7',
      'x-dpop-required': true,
    })
  })
})
