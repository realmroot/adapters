import { describe, expect, it } from 'vitest'
import { githubOpenApi } from '../../src/providers/github/openapi.js'

describe('GitHub OpenAPI permissions', () => {
  it('[spec: github-adapter/github-operation-permissions] publishes OR across requirements and AND within one requirement', async () => {
    const document = await githubOpenApi({
      resource: 'https://adapter.example/github',
      realmrootIssuer: 'https://id.example/api/auth',
      permissions: {
        administration: 'write',
        contents: 'write',
        issues: 'write',
        pull_requests: 'write',
        workflows: 'write',
      },
      response: Response.json({
        openapi: '3.0.3',
        info: { title: 'GitHub REST API', version: '1' },
        paths: {
          '/repos/{owner}/{repo}/issues/{issue_number}': { patch: { responses: { 200: {} } } },
          '/repos/{template_owner}/{template_repo}/generate': { post: { responses: { 201: {} } } },
          '/repos/{owner}/{repo}/contents/{path}': {
            put: { responses: { 200: {} } },
            delete: { responses: { 200: {} } },
          },
        },
      }),
    })

    expect(document.paths).toMatchObject({
      '/repos/{owner}/{repo}/issues/{issue_number}': {
        patch: {
          security: [{ realmrootOidc: ['issues:write'] }, { realmrootOidc: ['pull_requests:write'] }],
        },
      },
      '/repos/{template_owner}/{template_repo}/generate': {
        post: {
          security: [{ realmrootOidc: ['administration:write', 'contents:read'] }],
        },
      },
      '/repos/{owner}/{repo}/contents/{path}': {
        put: {
          security: [{ realmrootOidc: ['contents:write'] }, { realmrootOidc: ['contents:write', 'workflows:write'] }],
          'x-restish-security-alternatives': [
            {
              when: { pathParameter: 'path', prefix: '.github/workflows/' },
              alternatives: [1],
            },
          ],
        },
        delete: {
          security: [{ realmrootOidc: ['contents:write'] }, { realmrootOidc: ['contents:write', 'workflows:write'] }],
          'x-restish-security-alternatives': [
            {
              when: { pathParameter: 'path', prefix: '.github/workflows/' },
              alternatives: [1],
            },
          ],
        },
      },
    })
  })
})
