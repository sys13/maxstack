/**
 * Bundle the maxstack CLI into a single self-contained file for npm publish.
 *
 * Strategy: inline all first-party `@maxstack/*` workspace code (which is never
 * published on its own) plus every relative module, and leave third-party npm
 * packages + Node builtins external so they resolve from the published
 * package's own `dependencies`.
 *
 * Output goes to `dist/lib/cli.js` (two dirs deep) on purpose: `lib/config.ts`
 * computes `HUB_ROOT` as `../..` from its own location to find `templates/` and
 * its bundled `templates/`. Emitting the bundle at the same depth keeps that
 * resolution pointing at the package root after install.
 */
import { chmodSync, readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { build } from 'esbuild'

const root = fileURLToPath(new URL('.', import.meta.url))
const pkg = JSON.parse(readFileSync(new URL('./package.json', import.meta.url)))

// The CLI hardcodes its version in `CLI_VERSION`; keep it in lockstep with the manifest.
const programSrc = readFileSync(
	new URL('./src/program.ts', import.meta.url),
	'utf8',
)
const cliVersion = programSrc.match(/CLI_VERSION = '([^']+)'/)?.[1]
if (cliVersion !== pkg.version) {
	throw new Error(
		`version mismatch: package.json is ${pkg.version} but src/program.ts declares ${cliVersion}`,
	)
}

/** Externalize anything that isn't first-party (@maxstack/*) or relative. */
const externalizeThirdParty = {
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

const outfile = 'dist/lib/cli.js'

const result = await build({
	absWorkingDir: root,
	entryPoints: ['src/cli.ts'],
	outfile,
	bundle: true,
	platform: 'node',
	format: 'esm',
	target: 'node22',
	// esbuild preserves the entry file's `#!/usr/bin/env node` shebang; no banner needed.
	plugins: [externalizeThirdParty],
	metafile: true,
	logLevel: 'info',
})

chmodSync(new URL(`./${outfile}`, import.meta.url), 0o755)

// Report the external bare imports so package.json deps can be kept in sync.
const externals = new Set()
for (const out of Object.values(result.metafile.outputs)) {
	for (const imp of out.imports ?? []) {
		if (
			imp.external &&
			!imp.path.startsWith('node:') &&
			!imp.path.startsWith('.')
		) {
			// strip subpath (e.g. @maxstack/features/bundle → not external; drizzle-orm/pg-core → drizzle-orm)
			const parts = imp.path.split('/')
			externals.add(
				imp.path.startsWith('@') ? `${parts[0]}/${parts[1]}` : parts[0],
			)
		}
	}
}
const declared = new Set(Object.keys(pkg.dependencies ?? {}))
const missing = [...externals].filter((e) => !declared.has(e)).sort()
const unused = [...declared].filter((d) => !externals.has(d)).sort()
console.log(
	'\nexternal runtime imports:',
	[...externals].sort().join(', ') || '(none)',
)
// A missing dep is a broken tarball, not a note: the bundle imports it at the
// top of `cli.js`, so *every* command in the published CLI dies on
// ERR_MODULE_NOT_FOUND. This was a warning once and shipped exactly that.
if (missing.length) {
	console.error(
		`\n✗ these are imported by the bundle but NOT in ${pkg.name}'s dependencies:\n` +
			`    ${missing.join(', ')}\n` +
			`  The published CLI would fail to start. Declare them (or stop importing them).`,
	)
	process.exit(1)
}
if (unused.length)
	console.log('ℹ️  declared but not imported:', unused.join(', '))
