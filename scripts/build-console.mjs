import { copyFile, mkdir } from 'node:fs/promises'
import { build } from 'esbuild'

await mkdir('public/console', { recursive: true })
await build({
  entryPoints: ['web/main.tsx'],
  bundle: true,
  minify: true,
  format: 'esm',
  target: ['es2022'],
  outdir: 'public/console',
  jsx: 'automatic',
  jsxImportSource: 'hono/jsx/dom',
  tsconfig: 'web/tsconfig.json',
})
await copyFile('web/index.html', 'public/index.html')
