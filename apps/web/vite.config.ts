import { reactRouter } from '@react-router/dev/vite'
import tailwindcss from '@tailwindcss/vite'
import { defineConfig } from 'vite'
import { ownedSlotDevPlugin } from './vite-owned-slots-plugin.ts'

export default defineConfig({
	plugins: [
		tailwindcss(),
		reactRouter(),
		// `maxstack dev`'s owned-slot hot loop — dev-only (no-ops
		// unless MAXSTACK_PROJECT_APP_DIR is set), see the plugin file for why.
		// Its `enforce: 'pre'` resolveId intercepts `~/owned.generated` before
		// vite's native tsconfig-paths resolution (`resolve.tsconfigPaths`
		// below) can map `~/*` to the on-disk (always-empty) stub file: native
		// path resolution runs in vite's internal resolver, after every user
		// plugin's resolveId hook, so a `pre` plugin always wins the race.
		ownedSlotDevPlugin(),
	],
	// Native `~/*` → `./app/*` resolution from tsconfig's `paths` (replaces the
	// old `vite-tsconfig-paths` plugin, subsumed into vite core in v8).
	resolve: { tsconfigPaths: true },
	build: {
		// Source maps ship with the runtime. Three bugs in a row
		// (the MCP handshake 404, the zombie cookie banner #137, the date-input
		// mangling #139) lived in *this* bundle, and from inside a generated
		// project they were un-diagnosable: a minified chunk under a global npm
		// install, with no way to see which component rendered what. With maps,
		// devtools shows real component/file names and `--enable-source-maps`
		// (which `maxstack dev` passes to the prebuilt server) turns server
		// stack traces back into `app/…tsx:LINE`.
		//
		// The cost is tarball size, paid once at install; the maps are separate
		// `.map` files fetched only when devtools is open, so nothing about the
		// served app gets slower. Diagnosability of a runtime nobody can rebuild
		// is worth more than the megabytes. `MAXSTACK_NO_SOURCEMAP=1` opts out
		// for a size-sensitive build.
		sourcemap: !process.env.MAXSTACK_NO_SOURCEMAP,
	},
	// Under `maxstack dev` (which sets MAXSTACK_DATA_DIR) the app and the MCP
	// endpoint share one canonical host:port that `.mcp.json` points at:
	//   - `strictPort` binds that exact port or fails, never silently
	//     auto-incrementing onto another one (which stranded `.mcp.json`).
	//   - `host: '127.0.0.1'` pins the loopback family too. With no host vite
	//     listens on `localhost`, which on most machines is IPv6 `::1`-only, so
	//     every consumer (the port guard, the seeder, `.mcp.json`'s MCP client)
	//     independently had to compensate for which stack the server landed on
	//. Pinning IPv4 loopback makes them agree by construction —
	//     `.mcp.json` targets the same literal `127.0.0.1`, so no name resolution
	//     (and its IPv4-vs-IPv6 ambiguity) sits between client and server.
	// A plain `pnpm dev` keeps vite's default host + port-hunting, but starts
	// from 5179 rather than 5173 so it doesn't land on another local project's
	// dev server. No `strictPort` on this path — hunting is deliberate here,
	// since nothing is pinned to the address the way `.mcp.json` is above.
	server: process.env.MAXSTACK_DATA_DIR
		? { strictPort: true, host: '127.0.0.1' }
		: { port: 5179 },
	ssr: {
		// pglite ships a .wasm + .data pair loaded relative to its own module.
		// Bundling it into the server chunk orphans those files (ENOENT at
		// runtime), so keep it external and let Node resolve it from node_modules.
		external: ['@electric-sql/pglite'],
	},
	// Deps discovered *after* vite's startup optimization force a mid-flight
	// re-optimization that 504s ("Outdated Optimize Dep") every module still
	// being fetched with the stale hash, leaving pages stuck on their SSR
	// loading state. Two sources of late discovery are pinned away
	// here; this config is vendored verbatim into `<project>/.maxstack/runtime`,
	// so cold starts of the vendored dev server are covered too.
	optimizeDeps: {
		// @maxstack/ui is a linked source package, so the startup scan misses its
		// client deps — they'd be discovered on the first form-rendering request.
		// The `pkg > dep` form resolves each from @maxstack/ui (pnpm's strict
		// layout hides them from this app's root). zod is a direct dep reached
		// through server-side chains the scanner crawls; pre-bundling it is cheap.
		include: [
			'zod',
			'@maxstack/ui > @base-ui/react/checkbox',
			'@maxstack/ui > @base-ui/react/radio',
			'@maxstack/ui > @base-ui/react/radio-group',
			'@maxstack/ui > @base-ui/react/select',
			'@maxstack/ui > @conform-to/react',
			'@maxstack/ui > @conform-to/react/future',
			'@maxstack/ui > @conform-to/zod/v4',
			'@maxstack/ui > clsx',
			'@maxstack/ui > tailwind-merge',
		],
		// Server-only packages the scanner reaches by following route-module
		// imports into `*.server` chains. Real client transforms strip those
		// chains (none of these appear in the production client bundle), but the
		// scanner's late find still re-triggered optimization. Excluding them
		// keeps them out of the client optimizer entirely.
		exclude: [
			'@electric-sql/pglite',
			'better-auth',
			'better-auth/adapters/drizzle',
			'better-auth/plugins',
			'diff',
			'drizzle-orm',
			'drizzle-orm/pg-core',
			'drizzle-orm/pglite',
			'postgres',
			'react-dom/server',
			'ts-morph',
		],
	},
})
