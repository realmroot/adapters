import { createHash } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import { cloudflareOperations } from '../../src/providers/cloudflare/operation-permissions.js'

const root = resolve(import.meta.dirname, '../..')

describe('generated Cloudflare OpenAPI', () => {
  it('pins sources and partitions every official operation into one published route or explicit exclusion', async () => {
    const [source, catalog, exclusions, openapi] = await Promise.all([
      json('providers/cloudflare/source.json'),
      json('providers/cloudflare/oauth-scopes.json'),
      json('providers/cloudflare/exclusions.json'),
      json('public/cloudflare/openapi.json'),
    ])
    expect(source.commit).toMatch(/^[a-f0-9]{40}$/)
    expect(source.openapiSha256).toMatch(/^[a-f0-9]{64}$/)
    expect(catalog.sha256).toBe(createHash('sha256').update(JSON.stringify(catalog.scopes)).digest('hex'))
    expect(cloudflareOperations).toHaveLength(2652)
    expect(exclusions.operations).toHaveLength(634)
    expect(cloudflareOperations.length + exclusions.operations.length).toBe(3286)

    const routeKeys = new Set(cloudflareOperations.map((operation) => `${operation.method} ${operation.path}`))
    const exclusionKeys = new Set(
      exclusions.operations.map(
        (operation: { method: string; path: string }) => `${operation.method} ${operation.path}`,
      ),
    )
    expect(routeKeys.size).toBe(cloudflareOperations.length)
    expect(exclusionKeys.size).toBe(exclusions.operations.length)
    expect([...routeKeys].some((key) => exclusionKeys.has(key))).toBe(false)

    const catalogIds = new Set(catalog.scopes.map((scope: { id: string }) => scope.id))
    for (const operation of cloudflareOperations) {
      expect(operation.scopes.length).toBeGreaterThan(0)
      expect(operation.scopes.every((scope) => catalogIds.has(scope))).toBe(true)
      expect(openapi.paths[operation.path]?.[operation.method.toLowerCase()]?.operationId).toBe(operation.operationId)
    }
    expect(Buffer.byteLength(JSON.stringify(openapi))).toBeLessThan(20 * 1024 * 1024)
  })

  it('publishes Zone discovery and DNS read/write commands for Restish acceptance', async () => {
    const openapi = await json('public/cloudflare/openapi.json')
    expect(openapi.paths['/zones'].get.security).toContainEqual({ realmrootOidc: ['zone.read'] })
    expect(openapi['x-cli-config']).toEqual({ command_layout: 'tags' })
    expect(openapi.paths['/zones/{zone_id}/dns_records'].get.security).toEqual(
      expect.arrayContaining([{ realmrootOidc: ['dns.read'] }, { realmrootOidc: ['dns.write'] }]),
    )
    expect(openapi.paths['/zones/{zone_id}/dns_records'].post.security).toEqual([{ realmrootOidc: ['dns.write'] }])

    const addressMapMembership =
      openapi.paths['/accounts/{account_id}/addressing/address_maps/{address_map_id}/accounts/{account_id_2}'].delete
    expect(addressMapMembership.parameters).toEqual(
      expect.arrayContaining([expect.objectContaining({ in: 'path', name: 'account_id_2' })]),
    )
  })
})

async function json(path: string) {
  return JSON.parse(await readFile(resolve(root, path), 'utf8'))
}
