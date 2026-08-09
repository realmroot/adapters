import { readdir, readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

describe('Linear provider isolation', () => {
  it('[spec: linear-adapter/linear-provider-isolation] does not import another provider implementation', async () => {
    const directory = join(process.cwd(), 'src/providers/linear')
    const sources = await Promise.all(
      (await readdir(directory))
        .filter((file) => file.endsWith('.ts'))
        .map(async (file) => ({ file, source: await readFile(join(directory, file), 'utf8') })),
    )

    expect(sources.filter(({ source }) => /from\s+['"]\.\.\/(?!\.\.\/)/.test(source))).toEqual([])
  })
})
