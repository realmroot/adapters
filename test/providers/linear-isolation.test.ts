import { readdir, readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

describe('Provider isolation', () => {
  it.each([
    ['github', 'github-adapter/provider-isolation'],
    ['linear', 'linear-adapter/linear-provider-isolation'],
  ])('%s [spec: %s] does not import another provider implementation', async (provider) => {
    const directory = join(process.cwd(), 'src/providers', provider)
    const sources = await Promise.all(
      (await readdir(directory))
        .filter((file) => file.endsWith('.ts'))
        .map(async (file) => ({ file, source: await readFile(join(directory, file), 'utf8') })),
    )

    expect(sources.filter(({ source }) => /from\s+['"]\.\.\/(?!\.\.\/)/.test(source))).toEqual([])
    expect(sources.filter(({ source }) => source.includes('broker_request_replay'))).toEqual([])
  })
})
