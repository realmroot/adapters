import { linearScopeDescriptions, linearScopes } from './scopes.js'

const credentialIds = {
  read: 'realmrootRead',
  write: 'realmrootWrite',
  'issues:create': 'realmrootIssuesCreate',
  'comments:create': 'realmrootCommentsCreate',
  'timeSchedule:write': 'realmrootTimeScheduleWrite',
  'app:assignable': 'realmrootAppAssignable',
  'app:mentionable': 'realmrootAppMentionable',
  'customer:read': 'realmrootCustomerRead',
  'customer:write': 'realmrootCustomerWrite',
  'initiative:read': 'realmrootInitiativeRead',
  'initiative:write': 'realmrootInitiativeWrite',
} as const

export function linearOpenApi(input: { resource: string; realmrootIssuer: string }) {
  return {
    openapi: '3.1.0',
    info: {
      title: 'Linear GraphQL API through Realmroot',
      version: '2026-08-08',
      description:
        "Transparent transport for Linear's GraphQL API. The GraphQL document, variables, response status, headers, data, and errors follow Linear's public API.",
    },
    servers: [{ url: input.resource }],
    externalDocs: { url: 'https://linear.app/developers/graphql' },
    'x-realmroot-transparent-upstream': 'https://api.linear.app/graphql',
    paths: {
      '/graphql': {
        post: {
          operationId: 'executeLinearGraphqlRequest',
          summary: 'Execute an original Linear GraphQL request',
          description:
            'Required scopes are evaluated from the selected GraphQL operation before the request is forwarded.',
          'x-realmroot-dynamic-scope-evaluation': true,
          security: linearScopes.map((scope) => ({ [credentialIds[scope]]: [scope] })),
          requestBody: {
            required: true,
            content: {
              'application/json': {
                schema: {
                  type: 'object',
                  required: ['query'],
                  properties: {
                    query: { type: 'string' },
                    variables: { type: ['object', 'null'], additionalProperties: true },
                    operationName: { type: ['string', 'null'] },
                    extensions: { type: ['object', 'null'], additionalProperties: true },
                  },
                  additionalProperties: true,
                },
              },
            },
          },
          responses: {
            200: {
              description: 'Linear GraphQL response, which may contain data, errors, or both.',
              content: { 'application/json': { schema: {} } },
            },
            default: { description: 'Original Linear HTTP response or Realmroot authorization failure.' },
          },
        },
      },
    },
    components: {
      securitySchemes: {
        ...Object.fromEntries(
          linearScopes.map((scope) => [
            credentialIds[scope],
            {
              type: 'openIdConnect',
              openIdConnectUrl: `${input.realmrootIssuer}/.well-known/openid-configuration`,
              'x-dpop-required': true,
              description: `Realmroot Agent credential requesting Linear's ${scope} scope.`,
            },
          ]),
        ),
      },
    },
    'x-provider-scopes': Object.fromEntries(linearScopes.map((scope) => [scope, linearScopeDescriptions[scope]])),
  }
}
