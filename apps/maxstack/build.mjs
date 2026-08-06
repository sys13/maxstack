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
import {
	BUNDLE_OPTIONS,
	collectExternals,
	externalsDrift,
} from './scripts/bundle-externals.mjs'

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

const outfile = 'dist/lib/cli.js'

const result = await build({
	...BUNDLE_OPTIONS,
	absWorkingDir: root,
	outfile,
	// esbuild preserves the entry file's `#!/usr/bin/env node` shebang; no banner needed.
	logLevel: 'info',
})

chmodSync(new URL(`./${outfile}`, import.meta.url), 0o755)

// Report the external bare imports so package.json deps can be kept in sync.
const externals = collectExternals(result.metafile)
const declared = new Set(Object.keys(pkg.dependencies ?? {}))
const missing = externals.filter((e) => !declared.has(e))
const unused = [...declared].filter((d) => !externals.includes(d)).sort()
console.log('\nexternal runtime imports:', externals.join(', ') || '(none)')
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

// The external set is a ratchet, not a report — see scripts/bundle-externals.mjs
// for why each name is an install-surface decision. `pnpm test` checks this too,
// so a regression is caught on the PR rather than at `prepublishOnly`.
const drift = externalsDrift(externals)
if (drift) {
	console.error(
		`\n✗ the CLI bundle's external imports moved:\n` +
			(drift.added.length
				? `    now imported: ${drift.added.join(', ')}\n`
				: '') +
			(drift.gone.length
				? `    no longer imported: ${drift.gone.join(', ')}\n`
				: '') +
			`  Each one ships in the published tarball's install tree. If that is\n` +
			`  intended, update EXPECTED_EXTERNALS in scripts/bundle-externals.mjs.`,
	)
	process.exit(1)
}
