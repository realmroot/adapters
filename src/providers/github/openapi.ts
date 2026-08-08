export const adapterApiVersion = '2026-08-07'
export const githubScopes = ['github:metadata:read', 'github:issues:write'] as const

export function githubOpenApi(input: { resource: string; realmrootIssuer: string }) {
  const headers = {
    ApiVersion: {
      name: 'API-Version',
      in: 'header',
      required: false,
      schema: { type: 'string', const: adapterApiVersion, default: adapterApiVersion },
    },
    RequestId: {
      description: 'Request correlation identifier.',
      schema: { type: 'string' },
    },
  }
  return {
    openapi: '3.1.0',
    info: { title: 'Realmroot GitHub Adapter', version: '0.1.0' },
    servers: [{ url: input.resource }],
    tags: [{ name: 'GitHub repositories' }, { name: 'GitHub issues' }],
    components: {
      securitySchemes: {
        realmrootOidc: {
          type: 'openIdConnect',
          openIdConnectUrl: `${input.realmrootIssuer}/.well-known/openid-configuration`,
          'x-dpop-required': true,
        },
      },
      parameters: { ApiVersion: headers.ApiVersion },
      headers: { RequestId: headers.RequestId },
      schemas: {
        Problem: {
          type: 'object',
          required: ['type', 'title', 'status', 'detail', 'instance'],
          properties: {
            type: { type: 'string', format: 'uri-reference' },
            title: { type: 'string' },
            status: { type: 'integer' },
            detail: { type: 'string' },
            instance: { type: 'string', format: 'uri-reference' },
          },
        },
      },
    },
    paths: {
      '/repositories': {
        get: {
          operationId: 'listGitHubRepositories',
          tags: ['GitHub repositories'],
          parameters: [
            { $ref: '#/components/parameters/ApiVersion' },
            { name: 'page', in: 'query', schema: { type: 'integer', minimum: 1, default: 1 } },
            { name: 'perPage', in: 'query', schema: { type: 'integer', minimum: 1, maximum: 100, default: 30 } },
          ],
          security: [{ realmrootOidc: ['github:metadata:read'] }],
          responses: {
            '200': { description: 'Repositories selected across the connected GitHub App installations.' },
            '401': { description: 'Authentication failed.' },
            '403': { description: 'Authorization failed.' },
          },
        },
      },
      '/repos/{owner}/{repository}/issues': {
        post: {
          operationId: 'createGitHubIssue',
          tags: ['GitHub issues'],
          parameters: [
            { $ref: '#/components/parameters/ApiVersion' },
            { name: 'owner', in: 'path', required: true, schema: { type: 'string' } },
            { name: 'repository', in: 'path', required: true, schema: { type: 'string' } },
            { name: 'Idempotency-Key', in: 'header', required: true, schema: { type: 'string', maxLength: 200 } },
          ],
          requestBody: {
            required: true,
            content: {
              'application/json': {
                schema: {
                  type: 'object',
                  additionalProperties: false,
                  required: ['title'],
                  properties: { title: { type: 'string', minLength: 1 }, body: { type: 'string' } },
                },
              },
            },
          },
          security: [{ realmrootOidc: ['github:issues:write'] }],
          responses: {
            '201': { description: 'Issue created with Realmroot Agent attribution.' },
            '400': { description: 'Input or attribution marker is invalid.' },
            '401': { description: 'Authentication failed.' },
            '403': { description: 'Authorization failed.' },
            '409': { description: 'Idempotency key conflict.' },
          },
        },
      },
    },
  }
}
