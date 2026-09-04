import { openIdConfigurationUrl } from '../../core/external-authorization-server.js'

const scope = 'workspace:read'

export function fastioOpenApi(input: { resource: string; issuer: string }) {
  const security = [{ fastio: [scope] }]
  return {
    openapi: '3.1.0',
    info: {
      title: 'Fast.io through Realmroot',
      version: '2026-09-04',
      description: 'Inspect Fast.io workspaces through an Agent-bound, read-only OAuth resource.',
    },
    servers: [{ url: input.resource }],
    paths: {
      '/workspaces': {
        get: {
          operationId: 'listFastioWorkspaces',
          summary: 'List accessible workspaces',
          security,
          responses: {
            200: {
              description: 'All workspaces accessible to the connected user.',
              content: { 'application/json': { schema: { $ref: '#/components/schemas/WorkspaceCollection' } } },
            },
            default: { description: 'Fast.io response or Realmroot authorization failure.' },
          },
        },
      },
      '/profile-availability': {
        get: {
          operationId: 'getFastioProfileAvailability',
          summary: 'Get available profile types',
          security,
          responses: {
            200: {
              description: 'Availability of organizations, workspaces, shares, and pending invitations.',
              content: { 'application/json': { schema: { type: 'object', additionalProperties: true } } },
            },
            default: { description: 'Fast.io response or Realmroot authorization failure.' },
          },
        },
      },
    },
    components: {
      schemas: {
        WorkspaceCollection: {
          type: 'object',
          required: ['result', 'workspaces'],
          properties: {
            result: { type: 'boolean' },
            workspaces: {
              type: 'array',
              items: {
                type: 'object',
                required: ['id', 'name'],
                properties: {
                  id: { type: 'string' },
                  name: { type: 'string' },
                  folder_name: { type: 'string' },
                  description: { type: ['string', 'null'] },
                  closed: { type: 'boolean' },
                  archived: { type: 'boolean' },
                  user_status: { type: 'string' },
                  org_domain: { type: 'string' },
                },
                additionalProperties: true,
              },
            },
          },
          additionalProperties: true,
        },
      },
      securitySchemes: {
        fastio: {
          type: 'openIdConnect',
          openIdConnectUrl: openIdConfigurationUrl(input.issuer),
          'x-dpop-required': true,
          description: 'Realmroot Agent credential with approved Fast.io workspace access.',
        },
      },
    },
    'x-provider-upstream': 'https://api.fast.io',
  }
}
