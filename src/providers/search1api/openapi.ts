import { openIdConfigurationUrl } from '../../core/external-authorization-server.js'

const scope = 'search:read'

export function search1ApiOpenApi(input: { resource: string; issuer: string }) {
  const security = [{ search1Api: [scope] }]
  const searchRequest = {
    type: 'object',
    required: ['query'],
    properties: {
      query: { type: 'string', minLength: 1 },
      search_service: { type: 'string' },
      max_results: { type: 'integer', minimum: 1, maximum: 50, default: 5 },
      crawl_results: { type: 'integer', minimum: 0, maximum: 50, default: 0 },
      image: { type: 'boolean', default: false },
      include_sites: { type: 'array', items: { type: 'string' } },
      exclude_sites: { type: 'array', items: { type: 'string' } },
      language: { type: 'string' },
      time_range: { type: 'string', enum: ['day', 'week', 'month', 'year', ''] },
    },
    additionalProperties: false,
  }
  const createSearch = (operationId: string, summary: string) => ({
    operationId,
    summary,
    security,
    requestBody: {
      required: true,
      content: { 'application/json': { schema: searchRequest } },
    },
    responses: {
      200: {
        description: 'Search results.',
        content: { 'application/json': { schema: { type: 'object', additionalProperties: true } } },
      },
      default: { description: 'Search1API response or Realmroot authorization failure.' },
    },
  })
  return {
    openapi: '3.1.0',
    info: {
      title: 'Search1API through Realmroot',
      version: '2026-09-04',
      description: 'Search the web and news through an Agent-bound OAuth resource.',
    },
    servers: [{ url: input.resource }],
    paths: {
      '/searches': { post: createSearch('createWebSearch', 'Create a web search') },
      '/news-searches': { post: createSearch('createNewsSearch', 'Create a news search') },
      '/usage': {
        get: {
          operationId: 'getSearchUsage',
          summary: 'Get current Search1API usage',
          security,
          responses: {
            200: {
              description: 'Current usage and limits.',
              content: { 'application/json': { schema: { type: 'object', additionalProperties: true } } },
            },
            default: { description: 'Search1API response or Realmroot authorization failure.' },
          },
        },
      },
    },
    components: {
      securitySchemes: {
        search1Api: {
          type: 'openIdConnect',
          openIdConnectUrl: openIdConfigurationUrl(input.issuer),
          'x-dpop-required': true,
          description: 'Realmroot Agent credential with approved Search1API access.',
        },
      },
    },
    'x-provider-upstream': 'https://api.search1api.com',
  }
}
