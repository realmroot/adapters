import { openIdConfigurationUrl } from '../../core/external-authorization-server.js'
export function todoistOpenApi(input: { resource: string; issuer: string }) {
  const security = [{ todoistTasks: ['tasks:read'] }]
  const cursor = {
    name: 'cursor',
    in: 'query',
    required: false,
    description: 'Opaque cursor returned as next_cursor by the previous page.',
    schema: { type: 'string', minLength: 1 },
  }
  const limit = {
    name: 'limit',
    in: 'query',
    required: false,
    description: 'Maximum number of resources to return.',
    schema: { type: 'integer', minimum: 1, maximum: 200, default: 50 },
  }
  const optionalId = (name: string, description: string) => ({
    name,
    in: 'query',
    required: false,
    description,
    schema: { type: 'string', minLength: 1 },
  })
  const optionalInteger = (name: string, description: string) => ({
    name,
    in: 'query',
    required: false,
    description,
    schema: { type: 'integer', minimum: 1 },
  })

  return {
    openapi: '3.1.0',
    info: {
      title: 'Todoist through Realmroot',
      version: '2026-09-04',
      description: 'List Todoist projects and active tasks through an Agent-bound, read-only OAuth resource.',
    },
    servers: [{ url: input.resource }],
    paths: {
      '/projects': {
        get: {
          operationId: 'listTodoistProjects',
          summary: 'List active Todoist projects',
          security,
          parameters: [
            optionalInteger('folder_id', 'Filter projects by folder ID.'),
            optionalInteger('workspace_id', 'Filter projects by workspace ID.'),
            cursor,
            limit,
          ],
          responses: {
            200: {
              description: 'A page of active Todoist projects.',
              content: { 'application/json': { schema: { $ref: '#/components/schemas/ProjectPage' } } },
            },
            default: { description: 'Todoist response or Realmroot authorization failure.' },
          },
        },
      },
      '/tasks': {
        get: {
          operationId: 'listTodoistTasks',
          summary: 'List active Todoist tasks',
          security,
          parameters: [
            optionalId('project_id', 'Filter tasks by project ID.'),
            optionalId('section_id', 'Filter tasks by section ID.'),
            optionalId('parent_id', 'Filter tasks by parent task ID.'),
            optionalId('label', 'Filter tasks by label name.'),
            optionalId('ids', 'Comma-separated task IDs to retrieve.'),
            cursor,
            limit,
          ],
          responses: {
            200: {
              description: 'A page of active Todoist tasks.',
              content: { 'application/json': { schema: { $ref: '#/components/schemas/TaskPage' } } },
            },
            default: { description: 'Todoist response or Realmroot authorization failure.' },
          },
        },
      },
    },
    components: {
      schemas: {
        ProjectPage: {
          type: 'object',
          required: ['results'],
          properties: {
            results: { type: 'array', items: { $ref: '#/components/schemas/Project' } },
            next_cursor: { type: ['string', 'null'] },
          },
          additionalProperties: true,
        },
        Project: {
          type: 'object',
          required: ['id', 'name'],
          properties: {
            id: { type: 'string' },
            name: { type: 'string' },
            description: { type: 'string' },
            parent_id: { type: ['string', 'null'] },
            workspace_id: { type: ['integer', 'null'] },
            color: { type: 'string' },
            is_favorite: { type: 'boolean' },
            is_shared: { type: 'boolean' },
            inbox_project: { type: 'boolean' },
          },
          additionalProperties: true,
        },
        TaskPage: {
          type: 'object',
          required: ['results'],
          properties: {
            results: { type: 'array', items: { $ref: '#/components/schemas/Task' } },
            next_cursor: { type: ['string', 'null'] },
          },
          additionalProperties: true,
        },
        Task: {
          type: 'object',
          required: ['id', 'content', 'project_id'],
          properties: {
            id: { type: 'string' },
            content: { type: 'string' },
            description: { type: 'string' },
            project_id: { type: 'string' },
            section_id: { type: ['string', 'null'] },
            parent_id: { type: ['string', 'null'] },
            labels: { type: 'array', items: { type: 'string' } },
            priority: { type: 'integer', minimum: 1, maximum: 4 },
            checked: { type: 'boolean' },
            due: { type: ['object', 'null'], additionalProperties: true },
            deadline: { type: ['object', 'null'], additionalProperties: true },
          },
          additionalProperties: true,
        },
      },
      securitySchemes: {
        todoistTasks: {
          type: 'openIdConnect',
          openIdConnectUrl: openIdConfigurationUrl(input.issuer),
          'x-dpop-required': true,
          description: 'Realmroot Agent credential with approved read-only Todoist access.',
        },
      },
    },
    'x-provider-upstream': 'https://api.todoist.com/api/v1',
  }
}
