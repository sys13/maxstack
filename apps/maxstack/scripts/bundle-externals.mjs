/**
 * What the published CLI bundle leaves for npm to resolve — shared by the build
 * (`../build.mjs`) and the test that guards it (`../src/bundle-externals.test.ts`).
 *
 * These names are the CLI tarball's entire install surface. Under `npx` that
 * surface is materialized into a cache directory with no `overrides` applied, so
 * anything with an unsatisfiable peer becomes a tree npm can only complete by
 * placing a copy no dependency edge points at — and the next install into that
 * tree prunes it. That is #348: `better-auth` reached the bundle only because
 * `bundle/catalog.ts` took one DDL string through the `auth` barrel, and its
 * `@better-auth/drizzle-adapter` peers on a `drizzle-orm` our pin does not
 * satisfy. Every command, `init` first, died at import time on a second install.
 *
 * So the list is a ratchet in both directions. A new name is a decision about
 * what a stranger's `npx` has to resolve; a departed name is a win worth keeping.
 */

/** Externalize anything that isn't first-party (@maxstack/*) or relative. */
export const externalizeThirdParty = {
	name: 'externalize-third-party',
	setup(b) {
		b.onResolve({ filter: /.*/ }, (args) => {
			if (args.kind === 'entry-point') return null
			const p = args.path
			if (p.startsWith('.') || p.startsWith('/')) return null // relative → bundle
			if (p.startsWith('@maxstack/')) return null // first-party → bundle
			return { path: p, external: true } // third-party + node: builtins → external
		})
	},
}

/** esbuild options that reproduce the published bundle, minus the write. */
export const BUNDLE_OPTIONS = {
	entryPoints: ['src/cli.ts'],
	bundle: true,
	platform: 'node',
	format: 'esm',
	target: 'node22',
	plugins: [externalizeThirdParty],
	metafile: true,
}

/**
 * The npm packages the bundle imports, deduped to their package name.
 * `node:` builtins and relative paths are not an install surface, so they drop.
 */
export function collectExternals(metafile) {
	const externals = new Set()
	for (const out of Object.values(metafile.outputs)) {
		for (const imp of out.imports ?? []) {
			if (!imp.external) continue
			if (imp.path.startsWith('node:') || imp.path.startsWith('.')) continue
			// strip subpath: drizzle-orm/pg-core → drizzle-orm, @scope/a/b → @scope/a
			const parts = imp.path.split('/')
			externals.add(
				imp.path.startsWith('@') ? `${parts[0]}/${parts[1]}` : parts[0],
			)
		}
	}
	return [...externals].sort()
}

/** The externals the bundle is expected to have. Update deliberately. */
export const EXPECTED_EXTERNALS = [
	'@anthropic-ai/sdk',
	'@electric-sql/pglite',
	'commander',
	'diff',
	'drizzle-orm',
	'ts-morph',
	'zod',
]

/** `null` when `actual` matches {@link EXPECTED_EXTERNALS}, else what moved. */
export function externalsDrift(actual) {
	const added = actual.filter((e) => !EXPECTED_EXTERNALS.includes(e))
	const gone = EXPECTED_EXTERNALS.filter((e) => !actual.includes(e))
	if (!added.length && !gone.length) return null
	return { added, gone }
}
