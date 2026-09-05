# Public Adapter directory

The root page lists supported providers, capabilities, maturity, and deployment availability.
Visitors can search providers and filter by category without signing in.

The frontend uses Hono JSX DOM and a Hono RPC client for the public
`GET /console/api/providers` route. The route projects public metadata from `src/providers/registry.ts`, the same
registry used by the Worker to load provider modules. Each registration supplies
its factory, display metadata, and required configuration. Adding a registration
and deploying automatically adds it to the directory; no frontend list or icon
map needs updating. Merely creating an unregistered source file does not enable
a provider.

The route returns public metadata
and configuration availability, never credentials or account information.

Run `pnpm dev` and open the local Worker URL to review the directory. Run
`pnpm build` to build the page and validate the Worker bundle. `pnpm deploy`
builds and publishes both using the existing Worker assets binding.

Review the deployed root page on desktop and mobile, search for GitHub, select
Productivity, and verify that each card links to its provider documentation.
This page requires no application registration, secrets, or database migration.
