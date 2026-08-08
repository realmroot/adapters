import path from 'node:path'
import { cloudflareTest, readD1Migrations } from '@cloudflare/vitest-pool-workers'
import { configDefaults, defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    coverage: {
      provider: 'v8',
      reporter: ['text', 'json-summary', 'lcov'],
      include: ['src/**/*.ts'],
      exclude: ['src/worker.ts', 'src/storage/**'],
    },
    projects: [
      {
        test: {
          name: 'unit',
          environment: 'node',
          include: ['test/**/*.test.ts'],
          exclude: [...configDefaults.exclude, 'test/integration/**'],
        },
      },
      {
        plugins: [
          cloudflareTest(async () => ({
            main: './src/worker.ts',
            singleWorker: true,
            miniflare: {
              compatibilityDate: '2026-08-07',
              d1Databases: ['DB', 'MIGRATION_DB'],
              bindings: {
                TEST_MIGRATIONS: await readD1Migrations(path.join(import.meta.dirname, 'migrations')),
                REALMROOT_ISSUER: 'https://id.example/api/auth',
                REALMROOT_JWKS_URL: 'https://id.example/api/auth/jwks',
                REALMROOT_AGENT_PROFILE_URI_TEMPLATE: 'https://id.example/api/public/agents/{subject}',
                GITHUB_API_ORIGIN: 'https://api.github.com',
              },
            },
          })),
        ],
        test: {
          name: 'integration',
          include: ['test/integration/**/*.test.ts'],
          setupFiles: ['test/integration/apply-migrations.ts'],
        },
      },
    ],
  },
})
