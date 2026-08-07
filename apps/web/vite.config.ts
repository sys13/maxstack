import { reactRouter } from '@react-router/dev/vite'
import tailwindcss from '@tailwindcss/vite'
import { defineConfig, type Plugin } from 'vite'
import { ownedSlotDevPlugin } from './vite-owned-slots-plugin.ts'

const PGLITE_CLIENT_STUB = '\0maxstack:pglite-client-stub'

/**
 * Keep Postgres-in-WASM out of the *client* build.
 *
 * `@maxstack/core`'s `sprout/backend.ts` statically imports `@electric-sql/pglite`,
 * and `advancedChunks` groups every workspace-package source module into one
 * `maxstack-packages` chunk that exists in both environments — so the client
 * build walked into pglite too. Rollup then tree-shook the *code* back out (no
 * browser path calls it, and nothing in the emitted client chunks mentions
 * pglite), but assets are emitted during transform and emission is not
 * reverted. The result was three files nothing referenced —
 * `pglite.wasm` (10.1MB), `pglite.data` (6.3MB), `initdb.wasm` (0.4MB) —
 * **16.8MB of a 36MB runtime payload**, downloaded by every `npx maxstack`
 * and served to nobody. `ssr.external` below could not help: it only governs
 * the SSR environment, and the leak was on the client side.
 *
 * A stub rather than marking it external for the client: an external emits a
 * bare `@electric-sql/pglite` specifier into a browser chunk, which fails at
 * load with a resolution error and no clue why. The stub's export list is
 * deliberately *short* — anything the client graph reaches for beyond it is a
 * `MISSING_EXPORT` build failure naming the importing module, which is how this
 * asks to be re-examined rather than silently growing a second stub surface.
 *
 * The hook uses rolldown's `filter` form: an unfiltered `resolveId` is only
 * consulted for entry points here, so the bare specifier never reached it.
 *
 * `scripts/check-payload-budget.mjs` asserts the outcome (no orphan assets,
 * total under budget) so this stays fixed if the chunking or the import moves.
 */
function pgliteClientStub(): Plugin {
	return {
		name: 'maxstack:pglite-client-stub',
		enforce: 'pre',
		// Client only. The SSR build must keep resolving the real package —
		// `ssr.external` below hands it to node so the wasm/data pair stays
		// beside its own module, and stubbing it here would boot a server with
		// no database.
		applyToEnvironment: (environment) => environment.name === 'client',
		resolveId: {
			filter: { id: /^@electric-sql\/pglite(\/|$)/ },
			handler() {
				return PGLITE_CLIENT_STUB
			},
		},
		load(id) {
			if (id !== PGLITE_CLIENT_STUB) return null
			return `const serverOnly = () => {
	throw new Error(
		'@electric-sql/pglite is server-only — it reached a browser chunk. ' +
			'Move the call behind a .server module (see apps/web/vite.config.ts).',
	)
}
export const PGlite = new Proxy(function PGlite() {}, {
	construct: serverOnly,
	apply: serverOnly,
})
// drizzle-orm/pglite reads \`types.TIMESTAMP\` &c. at *module scope* to build an
// OID→parser table, so this one cannot throw on access. Each property answers
// with its own name: a unique, valid computed key, never a silent \`undefined\`
// that would collapse four table entries into one.
export const types = new Proxy({}, { get: (_target, prop) => prop })
export default PGlite
`
		},
	}
}

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
		// 16.8MB of orphaned Postgres-WASM out of the client build — see above.
		pgliteClientStub(),
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
		// Keep each workspace package's modules together in one chunk.
		//
		// Without this, rolldown places a module in whichever chunk its only
		// consumer landed in — so `features/bundle/seed.ts` was pulled into the
		// `sprout.server` chunk (its sole caller) while the barrel that
		// `export *`s it stayed in the `bundle` chunk. The barrel then imports the
		// symbol back across the boundary, and the two chunks form a cycle.
		//
		// A chunk cycle is not a tidiness problem. Chunks initialize in one order,
		// and a module-level `const` reading a binding from the other side of the
		// cycle can evaluate before that binding exists — reading `undefined` for
		// something the type system guarantees is an array. That is exactly how a
		// spread of `SPEC_OP_NAMES` in `@maxstack/mcp` took the production server
		// down at boot with "is not iterable" while typecheck, lint and every unit
		// test stayed green: none of them build chunks, so only the e2e smoke job
		// could see it.
		//
		// Grouping by package makes that cycle structurally impossible rather than
		// relying on nobody writing such a `const` again.
		rollupOptions: {
			output: {
				advancedChunks: {
					groups: [
						{
							name: 'maxstack-packages',
							test: /[\\/]packages[\\/][^\\/]+[\\/]src[\\/]/,
						},
					],
				},
			},
		},
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
