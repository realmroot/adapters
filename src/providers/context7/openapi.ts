import { openIdConfigurationUrl } from '../../core/external-authorization-server.js'

const documentationScope = 'documentation:read'

export function context7OpenApi(input: { resource: string; issuer: string }) {
  const security = [{ context7Documentation: [documentationScope] }]
  const query = {
    name: 'query',
    in: 'query',
    required: true,
    description: 'The current task or question, used by Context7 for relevance ranking.',
    schema: { type: 'string', minLength: 1, maxLength: 500 },
  }
  const fast = {
    name: 'fast',
    in: 'query',
    required: false,
    schema: { type: 'boolean', default: false },
  }
  return {
    openapi: '3.1.0',
    info: {
      title: 'Context7 through Realmroot',
      version: '2026-09-04',
      description:
        'Resolve software libraries and retrieve current documentation through an Agent-bound OAuth resource.',
    },
    servers: [{ url: input.resource }],
    paths: {
      '/libraries': {
        get: {
          operationId: 'listContext7Libraries',
          summary: 'List libraries matching a name and task',
          security,
          parameters: [
            {
              name: 'libraryName',
              in: 'query',
              required: true,
              description: 'Library name, such as react, nextjs, or hono.',
              schema: { type: 'string', minLength: 1, maxLength: 500 },
            },
            query,
            fast,
          ],
          responses: {
            200: {
              description: 'Ranked Context7 library resources.',
              content: { 'application/json': { schema: { $ref: '#/components/schemas/LibraryCollection' } } },
            },
            default: { description: 'Context7 response or Realmroot authorization failure.' },
          },
        },
      },
      '/documentation': {
        get: {
          operationId: 'getContext7Documentation',
          summary: 'Get documentation for a resolved library',
          security,
          parameters: [
            {
              name: 'libraryId',
              in: 'query',
              required: true,
              description: 'Exact Context7 library identifier returned by the libraries collection.',
              schema: { type: 'string', minLength: 1, maxLength: 500 },
            },
            query,
            {
              name: 'type',
              in: 'query',
              required: false,
              schema: { type: 'string', enum: ['json', 'txt'], default: 'txt' },
            },
            fast,
          ],
          responses: {
            200: {
              description: 'Context7 documentation selected for the task.',
              content: {
                'text/plain': { schema: { type: 'string' } },
                'application/json': { schema: { type: 'object', additionalProperties: true } },
              },
            },
            default: { description: 'Context7 response or Realmroot authorization failure.' },
          },
        },
      },
    },
    components: {
      schemas: {
        LibraryCollection: {
          type: 'object',
          required: ['results'],
          properties: {
            results: { type: 'array', items: { $ref: '#/components/schemas/Library' } },
            searchFilterApplied: { type: 'boolean' },
          },
          additionalProperties: true,
        },
        Library: {
          type: 'object',
          required: ['id', 'title'],
          properties: {
            id: { type: 'string' },
            title: { type: 'string' },
            description: { type: ['string', 'null'] },
            branch: { type: ['string', 'null'] },
            lastUpdateDate: { type: ['string', 'null'], format: 'date-time' },
            totalTokens: { type: ['integer', 'null'] },
            totalSnippets: { type: ['integer', 'null'] },
            stars: { type: ['integer', 'null'] },
            trustScore: { type: ['number', 'null'] },
          },
          additionalProperties: true,
        },
      },
      securitySchemes: {
        context7Documentation: {
          type: 'openIdConnect',
          openIdConnectUrl: openIdConfigurationUrl(input.issuer),
          'x-dpop-required': true,
          description: 'Realmroot Agent credential with approved Context7 documentation access.',
        },
      },
    },
    'x-provider-upstream': 'https://context7.com/api',
  }
}
