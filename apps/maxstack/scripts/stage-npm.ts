/**
 * Stage the two npm packages for release (run from `apps/maxstack`):
 *
 *   node --experimental-transform-types scripts/stage-npm.ts [--skip-web-build]
 *
 * Output: `dist-npm/maxstack/` and `dist-npm/maxstack-runtime/` (clean staging
 * dirs), plus the packed `.tgz` for each. Publish order matters — the CLI
 * depends on the runtime at an exact version, so publish `maxstack-runtime`
 * first, then `maxstack` (both need the account owner's OTP; see
 * docs/development.md).
 *
 * ## maxstack (the CLI)
 * The documented manual staging (docs/development.md "Cutting a release"),
 * codified: the esbuild bundle + templates + sanitized config, manifest
 * stripped of devDependencies/scripts, plus a pinned dependency on
 * `maxstack-runtime` so `dev`/`demo`/`build` work out of the box from npm.
 *
 * ## maxstack-runtime (the web runtime)
 * Three artifacts, consumed by `src/lib/runtime.ts`'s package mode:
 *   - `build/`         prebuilt react-router server + client assets (the same
 *                      artifact the Docker image runs; the five `@maxstack/*`
 *                      workspace packages are bundled in by the RR build).
 *   - `seed-demo.mjs`  the demo-data seeder bundled to plain node (the source
 *                      script needs vite's module runner; package mode has no
 *                      vite, so we pre-bundle with esbuild here instead).
 *   - `workspace/`     a source snapshot of the maxstack workspace with the same
 *                      relative layout, so `maxstack build` vendors from it
 *                      exactly as from a checkout. npm strips lockfiles and
 *                      interprets/strips `.gitignore` files inside tarballs,
 *                      so the lockfile ships renamed (restored by
 *                      `cloneWorkspace`) and ignore files are dropped.
 */

import { spawn } from 'node:child_process'
import {
	cp,
	mkdir,
	readdir,
	readFile,
	rename,
	rm,
	unlink,
	writeFile,
} from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { build } from 'esbuild'
import { cloneWorkspace, LOCKFILE_SNAPSHOT } from '../src/commands/build.ts'
import { buildChangelog } from './changelog.ts'

const appDir = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const maxstackRoot = resolve(appDir, '../..')
// Outside `apps/` on purpose: the snapshot clone copies `apps/` wholesale, and
// node's `cp` refuses a destination inside its source (before filters apply).
const out = resolve(maxstackRoot, 'dist-npm')
const skipWebBuild = process.argv.includes('--skip-web-build')

/** Basenames npm's packer strips or (worse) *interprets* as ignore rules —
 * they must not exist anywhere inside the published snapshot. */
const UNPUBLISHABLE = new Set([
	'.gitignore',
	'.npmignore',
	'.npmrc',
	'.DS_Store',
])

function run(cmd: string, args: string[], cwd: string): Promise<void> {
	return new Promise((res, reject) => {
		const child = spawn(cmd, args, { cwd, stdio: 'inherit' })
		child.on('error', reject)
		child.on('close', (code) =>
			code === 0
				? res()
				: reject(new Error(`${cmd} ${args[0]} exited ${code}`)),
		)
	})
}

/** Test files are dead weight in the snapshot (nothing in the vendor → docker
 * path runs them) and consumer-side tooling would happily discover them. */
const TEST_FILE = /\.test\.(ts|tsx|mts|js|jsx|mjs)$/

async function rmUnpublishable(dir: string): Promise<number> {
	let removed = 0
	for (const entry of await readdir(dir, { withFileTypes: true })) {
		const p = join(dir, entry.name)
		if (entry.isDirectory()) {
			removed += await rmUnpublishable(p)
		} else if (UNPUBLISHABLE.has(entry.name) || TEST_FILE.test(entry.name)) {
			await unlink(p)
			removed++
		}
	}
	return removed
}

const cliPkg = JSON.parse(
	await readFile(resolve(appDir, 'package.json'), 'utf8'),
)
const version: string = cliPkg.version
const webPkg = JSON.parse(
	await readFile(resolve(maxstackRoot, 'apps/web/package.json'), 'utf8'),
)

console.log(`staging maxstack + maxstack-runtime ${version} → ${out}\n`)
await rm(out, { recursive: true, force: true })
await mkdir(out, { recursive: true })

// A dirty checkout means the snapshot/build won't match a commit — say so.
const dirty = await new Promise<string>((res) => {
	const child = spawn('git', ['status', '--porcelain'], { cwd: maxstackRoot })
	let buf = ''
	child.stdout.on('data', (d) => {
		buf += d
	})
	child.on('close', () => res(buf.trim()))
	child.on('error', () => res(''))
})
if (dirty) {
	console.warn(
		`⚠ the checkout is dirty (${dirty.split('\n').length} path(s)) — the staged packages will include uncommitted changes.\n`,
	)
}

// ---- changelog ---------------------------------------------------------------
// Generated from the commit graph and persisted at the maxstack root (commit it
// with the release), then shipped inside both packages so npm/registry readers
// see what changed. One shared file — the two packages version in lockstep.
console.log('· generating CHANGELOG.md from the commit history…')
const changelog = await buildChangelog(version, cliPkg.repository, maxstackRoot)
const changelogPath = resolve(maxstackRoot, 'CHANGELOG.md')
await writeFile(changelogPath, changelog)
// Echo the top (this-version) section so the release runner can eyeball it.
const preview = changelog.split(/\n(?=## )/)[1]
if (preview)
	console.log(
		preview
			.trimEnd()
			.split('\n')
			.map((l) => `    ${l}`)
			.join('\n'),
	)

// ---- maxstack-runtime --------------------------------------------------------

const rtDir = resolve(out, 'maxstack-runtime')
await mkdir(rtDir, { recursive: true })

if (!skipWebBuild) {
	console.log('· building the web runtime (react-router build)…')
	await run('pnpm', ['--filter', '@maxstack/web', 'build'], maxstackRoot)
}
await cp(resolve(maxstackRoot, 'apps/web/build'), resolve(rtDir, 'build'), {
	recursive: true,
})

console.log('· bundling the demo seeder (esbuild)…')
const seedEntry = resolve(maxstackRoot, 'apps/web/scripts/.stage-seed-entry.ts')
await writeFile(
	seedEntry,
	`// Generated by stage-npm.ts — the seed-demo entry, bundled to plain node.
// Takes \`--clear\` so \`maxstack demo --clear\` works with no dev
// server running, the same way a plain \`maxstack demo\` does.
import { clearDemoData, getSprout, seedDemoData } from '../app/sprout.server.ts'

if (!process.env.MAXSTACK_DATA_DIR) {
	console.error('MAXSTACK_DATA_DIR is not set — run this via \`maxstack demo <dir>\`.')
	process.exit(1)
}
if (process.argv.includes('--clear')) {
	const result = await clearDemoData()
	console.log(
		result.cleared > 0
			? \`✓ removed \${result.cleared} demo row(s)\${result.resources.length ? \` (\${result.resources.join(', ')})\` : ''}\`
			: '· no demo rows to remove — nothing was tracked as demo data',
	)
	if (result.missing > 0) {
		console.log(\`· \${result.missing} tracked row(s) were already gone\`)
	}
} else {
	const result = await seedDemoData()
	if (result.seeded) {
		console.log(
			result.resources.length > 0
				? \`✓ demo data loaded (\${result.resources.join(', ')})\`
				: '✓ demo data loaded',
		)
	} else {
		console.log('· nothing to seed — every resource already has data')
	}
}
const { backend } = await getSprout()
await backend.dispose()
process.exit(0)
`,
)
let seedExternals: Set<string>
try {
	const result = await build({
		absWorkingDir: resolve(maxstackRoot, 'apps/web'),
		entryPoints: [seedEntry],
		outfile: resolve(rtDir, 'seed-demo.mjs'),
		bundle: true,
		platform: 'node',
		format: 'esm',
		target: 'node22',
		tsconfig: resolve(maxstackRoot, 'apps/web/tsconfig.json'),
		metafile: true,
		logLevel: 'warning',
		plugins: [
			{
				name: 'externalize-third-party',
				setup(b) {
					b.onResolve({ filter: /.*/ }, (args) => {
						if (args.kind === 'entry-point') return null
						const p = args.path
						if (p.startsWith('.') || p.startsWith('/') || p.startsWith('~/'))
							return null
						if (p.startsWith('@maxstack/')) return null
						return { path: p, external: true }
					})
				},
			},
		],
	})
	seedExternals = new Set(
		Object.values(result.metafile.outputs)
			.flatMap((o) => o.imports ?? [])
			.filter((i) => i.external && !i.path.startsWith('node:'))
			.map((i) => {
				const parts = i.path.split('/')
				return i.path.startsWith('@') ? `${parts[0]}/${parts[1]}` : parts[0]
			}),
	)
} finally {
	await unlink(seedEntry)
}

console.log('· cloning the workspace snapshot…')
await cloneWorkspace(maxstackRoot, resolve(rtDir, 'workspace'))
await rename(
	resolve(rtDir, 'workspace/pnpm-lock.yaml'),
	resolve(rtDir, 'workspace', LOCKFILE_SNAPSHOT),
)
await cp(
	resolve(maxstackRoot, '.dockerignore'),
	resolve(rtDir, 'workspace/.dockerignore'),
)
const stripped = await rmUnpublishable(resolve(rtDir, 'workspace'))
if (stripped)
	console.log(`  (${stripped} test/ignore file(s) stripped from the snapshot)`)

// Runtime deps = apps/web's third-party deps ∪ those of every workspace package
// whose *source* the RR build and the seed bundle inline. A workspace package is
// never installed from the registry, so its own externals surface as runtime
// imports of the server and the seeder — `postgres` is a dynamic import taken on
// the postgres-backend path, `diff` rides along in the seed graph, and the seed
// entry reaches `@maxstack/features/storage` and `@maxstack/ui`, none of which
// apps/web's manifest lists. (The SDK's `@aws-sdk/signature-v4-crt` is its usual
// guarded-optional require — never emitted as an import, so it stays omitted.)
const inlinedPkgs = await Promise.all(
	['packages/maxstack-core', 'packages/features', 'packages/ui'].map(
		async (dir) =>
			JSON.parse(
				await readFile(resolve(maxstackRoot, dir, 'package.json'), 'utf8'),
			) as { dependencies?: Record<string, string> },
	),
)
const rtDeps = Object.fromEntries(
	[
		...inlinedPkgs.flatMap((p) => Object.entries(p.dependencies ?? {})),
		...Object.entries(webPkg.dependencies as Record<string, string>),
	].filter(([, range]) => !range.startsWith('workspace:')),
)
const missing = [...seedExternals].filter((e) => !(e in rtDeps))
if (missing.length) {
	throw new Error(
		`seed bundle imports packages missing from the runtime deps: ${missing.join(', ')}`,
	)
}

await writeFile(
	resolve(rtDir, 'package.json'),
	`${JSON.stringify(
		{
			name: 'maxstack-runtime',
			version,
			type: 'module',
			description:
				'The maxstack web runtime: prebuilt spec-interpreter server, demo seeder, and the workspace source snapshot `maxstack build` vendors from.',
			license: 'MIT',
			homepage: cliPkg.homepage,
			repository: cliPkg.repository,
			bugs: cliPkg.bugs,
			keywords: ['maxstack', 'runtime', 'react', 'full-stack', 'framework'],
			files: [
				'build',
				'workspace',
				'seed-demo.mjs',
				'README.md',
				'CHANGELOG.md',
			],
			engines: { node: '>=22' },
			publishConfig: { access: 'public' },
			dependencies: rtDeps,
		},
		null,
		2,
	)}\n`,
)
await writeFile(
	resolve(rtDir, 'README.md'),
	`# maxstack-runtime

The maxstack web runtime, published for the \`maxstack\` CLI to run against —
you install [\`maxstack\`](https://www.npmjs.com/package/maxstack) and get this
as a dependency; you don't use this package directly.

- \`build/\` — the prebuilt spec-interpreter server (\`maxstack dev\` runs it
  over your project's \`spec/\` dir).
- \`seed-demo.mjs\` — the demo-data seeder (\`maxstack demo\`).
- \`workspace/\` — the runtime's source snapshot; \`maxstack build\` vendors it
  under \`<project>/.maxstack/runtime/\` to compile your owned code into a
  deployable Docker image.
`,
)
await cp(changelogPath, resolve(rtDir, 'CHANGELOG.md'))

// ---- maxstack (the CLI) --------------------------------------------------------

const cliDir = resolve(out, 'maxstack')
await mkdir(cliDir, { recursive: true })
console.log('\n· building the CLI bundle (build.mjs)…')
await run(process.execPath, ['build.mjs'], appDir)
for (const f of ['dist', 'templates', 'README.md']) {
	await cp(resolve(appDir, f), resolve(cliDir, f), { recursive: true })
}
// The generated changelog lives at the maxstack root, not in `apps/maxstack/`.
await cp(changelogPath, resolve(cliDir, 'CHANGELOG.md'))
const staged = { ...cliPkg }
delete staged.devDependencies
delete staged.scripts
if (Array.isArray(staged.files) && !staged.files.includes('CHANGELOG.md'))
	staged.files = [...staged.files, 'CHANGELOG.md']
// Pin the runtime exactly: the two ship in lockstep, and a range would let a
// stale/newer runtime pair with an old CLI.
staged.dependencies = { ...staged.dependencies, 'maxstack-runtime': version }
await writeFile(
	resolve(cliDir, 'package.json'),
	`${JSON.stringify(staged, null, 2)}\n`,
)

// The config-leak regression (the 0.9.1 tarball shipped personal values) is now
// structurally impossible: the file isn't in the tarball at all.

// ---- pack both -----------------------------------------------------------------

console.log('\n· packing…')
await run('npm', ['pack', '--pack-destination', out], rtDir)
await run('npm', ['pack', '--pack-destination', out], cliDir)

console.log(
	`\n✔ staged ${version}. Publish order (runtime first — the CLI pins it):` +
		`\n  npm publish ${out}/maxstack-runtime-${version}.tgz --access public --otp=<code>` +
		`\n  npm publish ${out}/maxstack-${version}.tgz --access public --otp=<code>`,
)
