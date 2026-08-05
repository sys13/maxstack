/**
 * Interactive release orchestrator for the two lockstep npm packages
 * (`maxstack-runtime` + `maxstack`). Run from `apps/maxstack`:
 *
 *   node --experimental-transform-types scripts/publish.ts
 *
 * Pass `-y` / `--yes` to auto-confirm every routine step (useful when you'd say
 * yes to almost all of them anyway). Genuine safety gates — already-on-npm, a
 * dirty checkout, a failed smoke test — are NOT auto-overridden: under --yes they
 * abort rather than steamroll, so a real problem still stops the cut.
 *
 * It walks the whole cut end-to-end, pausing for a y/N before every step that
 * touches the outside world (publish, push, GitHub release):
 *
 *   1. version    — bump package.json + cli.ts together (patch/minor/major or a
 *                   custom value), asserting they were in sync first; then
 *                   confirm the target isn't already on npm
 *   2. clean copy — refuse a dirty checkout, then stage a fresh build+pack
 *                   (scripts/stage-npm.ts: RR build, seeder, snapshot, tarballs)
 *   3. smoke test — optional: install both tarballs in a throwaway dir and run
 *                   the documented CLI checks
 *   4. login      — `npm whoami`; if logged out, `npm login` (auth-type=web, so
 *                   npm opens the BROWSER — no OTP code is entered here)
 *   5. publish    — runtime first (the CLI pins it), then the CLI. Plain
 *                   `npm publish`; with auth-type=web npm prints a URL / opens
 *                   the browser for you to approve. NO --otp.
 *   6. verify     — `npm view` both packages report the new version
 *   7. commit     — `chore(release): maxstack@<v>` + push
 *   8. gh release — optional `gh release create v<v>` with the changelog notes
 *
 * Nothing here is destructive until you say yes: everything up to step 5 is
 * local, and each network step is individually confirmed.
 */

import { spawn } from 'node:child_process'
import { readFile, writeFile } from 'node:fs/promises'
import { dirname, resolve } from 'node:path'
import { createInterface } from 'node:readline/promises'
import { fileURLToPath } from 'node:url'

const appDir = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const maxstackRoot = resolve(appDir, '../..')
const distNpm = resolve(maxstackRoot, 'dist-npm')

// `-y` / `--yes` answers every ROUTINE step automatically. Genuine safety gates
// (already-on-npm, dirty tree, smoke-test failure) are NOT auto-overridden — under
// --yes they take their safe answer (no) and abort, so a real problem still stops
// the cut instead of being silently steamrolled.
const autoYes = process.argv.slice(2).some((a) => a === '-y' || a === '--yes')

const rl = createInterface({ input: process.stdin, output: process.stdout })
const C = {
	dim: (s: string) => `\x1b[2m${s}\x1b[0m`,
	bold: (s: string) => `\x1b[1m${s}\x1b[0m`,
	green: (s: string) => `\x1b[32m${s}\x1b[0m`,
	yellow: (s: string) => `\x1b[33m${s}\x1b[0m`,
	red: (s: string) => `\x1b[31m${s}\x1b[0m`,
	cyan: (s: string) => `\x1b[36m${s}\x1b[0m`,
}

let step = 0
function heading(title: string): void {
	step++
	console.log(
		`\n${C.bold(C.cyan(`━━ ${step}. ${title} `))}${C.cyan('━'.repeat(Math.max(0, 40 - title.length)))}`,
	)
}

/** y/N confirm for a ROUTINE step. Default no unless `defaultYes`. Empty answer
 * takes the default. Under `--yes` it auto-answers yes without prompting. */
async function confirm(q: string, defaultYes = false): Promise<boolean> {
	if (autoYes) {
		console.log(`${C.yellow('?')} ${q} ${C.dim('[--yes → y]')}`)
		return true
	}
	const hint = defaultYes ? 'Y/n' : 'y/N'
	const a = (await rl.question(`${C.yellow('?')} ${q} ${C.dim(`[${hint}]`)} `))
		.trim()
		.toLowerCase()
	if (a === '') return defaultYes
	return a === 'y' || a === 'yes'
}

/** A safety gate: "yes" means override a detected problem. ALWAYS prompts when
 * interactive (default no); under `--yes` it does NOT auto-override — it answers
 * no so the caller aborts, keeping a non-interactive run safe. */
async function gate(q: string): Promise<boolean> {
	if (autoYes) {
		console.log(`${C.yellow('?')} ${q} ${C.dim('[--yes → n, aborting]')}`)
		return false
	}
	const a = (await rl.question(`${C.yellow('?')} ${q} ${C.dim('[y/N]')} `))
		.trim()
		.toLowerCase()
	return a === 'y' || a === 'yes'
}

/** Spawn with the terminal attached (stdio inherit) so interactive prompts —
 * npm's browser-auth flow especially — reach the user. Rejects on non-zero. */
function run(cmd: string, args: string[], cwd = maxstackRoot): Promise<void> {
	console.log(C.dim(`  $ ${cmd} ${args.join(' ')}`))
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

/** Capture stdout of a short command (trimmed). Never throws — returns ''. */
function capture(
	cmd: string,
	args: string[],
	cwd = maxstackRoot,
): Promise<string> {
	return new Promise((res) => {
		const child = spawn(cmd, args, { cwd })
		let out = ''
		child.stdout.on('data', (d) => {
			out += d
		})
		child.on('close', () => res(out.trim()))
		child.on('error', () => res(''))
	})
}

function abort(msg: string): never {
	console.error(`\n${C.red('✗')} ${msg}`)
	rl.close()
	process.exit(1)
}

// This flow is a series of prompts, so it needs a real interactive terminal —
// UNLESS `--yes` was passed, in which case nothing is ever read from stdin and a
// non-interactive run is fine. Under a non-interactive stdin without --yes,
// readline hits EOF and closes, and the first `question()` throws
// ERR_USE_AFTER_CLOSE with a confusing stack. Fail early and clearly instead.
if (!process.stdin.isTTY && !autoYes) {
	console.error(
		`${C.red('✗')} scripts/publish.ts is interactive and needs a TTY.\n` +
			'  Run it directly in a terminal:\n' +
			`    ${C.bold('cd apps/maxstack && npm run release')}\n` +
			`  or pass ${C.bold('--yes')} to auto-confirm every routine step.\n` +
			'  (not through a pipe, CI, or a non-interactive task runner.)',
	)
	process.exit(1)
}

// ── 1. version: bump both files in lockstep ──────────────────────────────────
heading('Version')

const pkgPath = resolve(appDir, 'package.json')
const cliPath = resolve(appDir, 'src/program.ts')
const cliPkg = JSON.parse(await readFile(pkgPath, 'utf8'))
const current: string = cliPkg.version
let cliSrc = await readFile(cliPath, 'utf8')
const declared = cliSrc.match(/CLI_VERSION = ['"]([^'"]+)['"]/)?.[1]
if (declared !== current) {
	abort(
		`version mismatch: package.json is ${C.bold(current)} but src/program.ts declares ${C.bold(declared ?? '?')}.\n` +
			`  Reconcile them to the same value before releasing.`,
	)
}
console.log(
	`  current: ${C.bold(current)} ${C.dim('(package.json === src/program.ts)')}`,
)

/** Return `x.y.z` with the requested segment incremented and lower ones zeroed. */
function bump(v: string, kind: 'major' | 'minor' | 'patch'): string {
	const m = v.match(/^(\d+)\.(\d+)\.(\d+)(.*)$/)
	if (!m) return v
	let [maj, min, pat] = [Number(m[1]), Number(m[2]), Number(m[3])]
	if (kind === 'major') [maj, min, pat] = [maj + 1, 0, 0]
	else if (kind === 'minor') [min, pat] = [min + 1, 0]
	else pat += 1
	return `${maj}.${min}.${pat}`
}

const choices: Array<{ key: string; label: string; value: string }> = [
	{
		key: '1',
		label: `patch → ${bump(current, 'patch')}`,
		value: bump(current, 'patch'),
	},
	{
		key: '2',
		label: `minor → ${bump(current, 'minor')}`,
		value: bump(current, 'minor'),
	},
	{
		key: '3',
		label: `major → ${bump(current, 'major')}`,
		value: bump(current, 'major'),
	},
	{ key: '4', label: 'custom (type a version)', value: '' },
	{ key: '5', label: `keep ${current} (already bumped)`, value: current },
]
console.log(C.dim('  bump:'))
for (const c of choices) console.log(`    ${C.bold(c.key)}) ${c.label}`)
const pick =
	(await rl.question(`${C.yellow('?')} choose 1-5 ${C.dim('[1]')} `)).trim() ||
	'1'
const chosen = choices.find((c) => c.key === pick)
if (!chosen) abort(`unknown choice "${pick}".`)

let version: string = chosen.value
if (chosen.key === '4') {
	version = (await rl.question(`${C.yellow('?')} new version: `))
		.trim()
		.replace(/^v/, '')
	if (!/^\d+\.\d+\.\d+/.test(version))
		abort(`"${version}" is not a semver x.y.z.`)
}

// Snapshot the tree BEFORE we write the bump, so step 2's clean-checkout guard
// can tell an otherwise-clean release apart from a genuinely dirty one.
const preBumpDirty = await capture('git', ['status', '--porcelain'])

if (version !== current) {
	if (
		!(await confirm(
			`Write ${C.bold(current)} → ${C.bold(version)} in package.json + src/program.ts?`,
			true,
		))
	)
		abort('version unchanged — nothing written.')
	cliPkg.version = version
	await writeFile(pkgPath, `${JSON.stringify(cliPkg, null, '\t')}\n`)
	cliSrc = cliSrc.replace(/(CLI_VERSION = ['"])[^'"]+(['"])/, `$1${version}$2`)
	await writeFile(cliPath, cliSrc)
	console.log(
		`${C.green('✓')} bumped to ${C.bold(version)} (build.mjs asserts the two stay in sync)`,
	)
} else {
	console.log(`${C.dim('  keeping')} ${C.bold(version)}`)
}

const onRegistry = await capture('npm', [
	'view',
	`maxstack@${version}`,
	'version',
])
if (onRegistry === version) {
	if (!(await gate(`maxstack@${version} is ALREADY on npm. Re-run anyway?`)))
		abort('that version is published — pick a higher one.')
} else {
	console.log(`${C.green('✓')} maxstack@${version} is not yet on the registry`)
}

const branch = await capture('git', ['rev-parse', '--abbrev-ref', 'HEAD'])
console.log(`${C.dim(`  branch: ${branch}`)}`)

// ── 2. fresh copy: refuse dirty, then stage ──────────────────────────────────
heading('Fresh copy + build + pack')

// The version bump itself makes the tree dirty and that's expected; only warn
// about paths that were already dirty before this run touched anything.
if (preBumpDirty) {
	console.log(
		C.yellow(
			`⚠ the checkout had ${preBumpDirty.split('\n').length} uncommitted path(s) before the bump.\n` +
				`  The staged snapshot and prebuilt server ship whatever is on disk — a release\n` +
				`  should come from an otherwise-clean tree so the artifacts match a commit.`,
		),
	)
	if (!(await gate('Stage from this dirty tree anyway?')))
		abort('commit or stash your other changes, then re-run.')
} else {
	console.log(
		`${C.green('✓')} clean checkout (only the version bump is pending)`,
	)
}

if (await confirm('Stage both packages now (fresh RR build + pack)?', true)) {
	await run(
		process.execPath,
		['--experimental-transform-types', 'scripts/stage-npm.ts'],
		appDir,
	)
} else {
	console.log(
		C.dim('  skipped — assuming dist-npm/ is already staged for this version.'),
	)
}

const runtimeTgz = resolve(distNpm, `maxstack-runtime-${version}.tgz`)
const cliTgz = resolve(distNpm, `maxstack-${version}.tgz`)

// ── 3. smoke test (optional) ─────────────────────────────────────────────────
heading('Smoke test the tarballs (optional)')
if (
	await confirm(
		'Install both tarballs in a throwaway dir and run the CLI checks?',
	)
) {
	// The documented clean-dir smoke test (docs/development.md step 3), condensed.
	const script =
		`set -e; T=$(mktemp -d); cd "$T"; npm init -y >/dev/null; ` +
		`echo "installing into $T"; ` +
		`npm install "${runtimeTgz}" "${cliTgz}" >/dev/null 2>&1; ` +
		`echo -n "maxstack --version → "; ./node_modules/.bin/maxstack --version; ` +
		`./node_modules/.bin/maxstack init demo >/dev/null && cd demo; ` +
		`../node_modules/.bin/maxstack build --vendor-only >/dev/null && echo "✓ vendor-only build ok"; ` +
		`echo "smoke dir: $T"`
	try {
		await run('bash', ['-c', script])
		console.log(`${C.green('✓')} smoke test passed`)
	} catch {
		if (!(await gate('Smoke test failed. Continue to publish anyway?')))
			abort('fix the smoke-test failure and re-run.')
	}
} else {
	console.log(C.dim('  skipped.'))
}

// ── 4. login (browser, no OTP) ───────────────────────────────────────────────
heading('npm login')
const authType = await capture('npm', ['config', 'get', 'auth-type'])
const who = await capture('npm', ['whoami'])
if (who) {
	console.log(
		`${C.green('✓')} logged in as ${C.bold(who)}${authType ? C.dim(`  (auth-type=${authType})`) : ''}`,
	)
} else {
	console.log(
		C.yellow('⚠ not logged in to npm.') +
			(authType === 'web'
				? C.dim(
						'\n  auth-type=web → `npm login` will open your BROWSER to authorize. No OTP code needed.',
					)
				: C.dim(
						`\n  auth-type=${authType || 'legacy'} — consider \`npm config set auth-type web\` for the browser flow.`,
					)),
	)
	if (!(await confirm('Run `npm login` now?', true)))
		abort('log in, then re-run.')
	await run('npm', ['login'])
	const who2 = await capture('npm', ['whoami'])
	if (!who2) abort('still not logged in.')
	console.log(`${C.green('✓')} logged in as ${C.bold(who2)}`)
}

// ── 5. publish (runtime first) ───────────────────────────────────────────────
heading('Publish to npm')
console.log(
	C.dim(
		'  Order matters: publish maxstack-runtime FIRST (the CLI pins it at an exact\n' +
			'  version, so a CLI without its runtime on the registry is uninstallable).\n' +
			'  With auth-type=web, npm will open the browser to approve each publish —\n' +
			`  ${C.bold('watch for the URL / browser prompt')} and approve it there. No OTP code.`,
	),
)

if (await confirm(`Publish ${C.bold(`maxstack-runtime@${version}`)} now?`)) {
	await run('npm', ['publish', runtimeTgz, '--access', 'public'])
	console.log(`${C.green('✓')} maxstack-runtime@${version} published`)
} else {
	abort('publish aborted before the runtime — nothing was published.')
}

if (
	await confirm(`Publish ${C.bold(`maxstack@${version}`)} (the CLI) now?`, true)
) {
	await run('npm', ['publish', cliTgz, '--access', 'public'])
	console.log(`${C.green('✓')} maxstack@${version} published`)
} else {
	console.log(
		C.yellow(
			`⚠ the runtime is published but the CLI is NOT. Finish with:\n` +
				`    npm publish ${cliTgz} --access public`,
		),
	)
	abort('CLI publish skipped.')
}

// ── 6. verify ────────────────────────────────────────────────────────────────
heading('Verify on the registry')
const cliView = await capture('npm', ['view', 'maxstack', 'version'])
const rtView = await capture('npm', ['view', 'maxstack-runtime', 'version'])
const dep = await capture('npm', [
	'view',
	`maxstack@${version}`,
	'dependencies.maxstack-runtime',
])
console.log(
	`  maxstack           → ${cliView === version ? C.green(cliView) : C.red(cliView || '?')}`,
)
console.log(
	`  maxstack-runtime   → ${rtView === version ? C.green(rtView) : C.red(rtView || '?')}`,
)
console.log(
	`  maxstack pins rt   → ${dep === version ? C.green(dep) : C.yellow(dep || '?')}`,
)
if (cliView !== version || rtView !== version)
	console.log(
		C.yellow(
			'  (registry may lag a few seconds — re-check with `npm view maxstack version`.)',
		),
	)

// ── 7. commit + push the release ─────────────────────────────────────────────
heading('Commit + push the release')
const releaseMsg = `chore(release): maxstack@${version}`
const postDirty = await capture('git', ['status', '--porcelain'])
if (postDirty) {
	console.log(C.dim('  changed paths:'))
	console.log(
		postDirty
			.split('\n')
			.map((l) => `    ${l}`)
			.join('\n'),
	)
	if (await confirm(`Commit these as "${releaseMsg}" and push?`, true)) {
		await run('git', ['add', '-A'])
		await run('git', ['commit', '-m', releaseMsg])
		if (await confirm(`Push to origin/${branch}?`, true)) {
			await run('git', ['push', 'origin', branch])
			console.log(`${C.green('✓')} pushed`)
		}
	} else {
		console.log(
			C.dim('  skipped — commit the version bump + CHANGELOG.md yourself.'),
		)
	}
} else {
	console.log(
		C.dim(
			'  working tree is clean — nothing to commit (version bump already committed?).',
		),
	)
}

// ── 8. GitHub release (optional) ─────────────────────────────────────────────
heading('GitHub release (optional)')
const tag = `v${version}`
const hasGh = (await capture('gh', ['--version'])).length > 0
if (!hasGh) {
	console.log(
		C.dim(
			'  gh CLI not found — skipping. Install from https://cli.github.com/ to enable.',
		),
	)
} else if (
	await confirm(
		`Create GitHub release ${C.bold(tag)} with the CHANGELOG notes?`,
	)
) {
	// Pull this version's section out of the generated changelog for the notes.
	let notes = ''
	try {
		const changelog = await readFile(
			resolve(maxstackRoot, 'CHANGELOG.md'),
			'utf8',
		)
		notes =
			changelog
				.split(/\n(?=## )/)
				.find((s) => s.startsWith(`## ${version}`) || s.includes(version)) ?? ''
	} catch {
		/* no changelog — release with an empty body */
	}
	const args = [
		'release',
		'create',
		tag,
		'--title',
		`maxstack ${version}`,
		'--target',
		branch,
	]
	// Notes go through a file, not an inline --notes arg: the changelog section is
	// multi-line and the inline form both mangles the echoed command and is more
	// fragile. --notes-file keeps the spawn args short and printable.
	let notesFile = ''
	if (notes.trim()) {
		notesFile = resolve(distNpm, `release-notes-${version}.md`)
		await writeFile(notesFile, `${notes.trim()}\n`)
		args.push('--notes-file', notesFile)
	} else {
		args.push('--generate-notes')
	}
	// `gh release create --target <branch>` needs the branch tip visible on the
	// remote; right after a push GitHub can briefly lag, which fails the create.
	// Retry once before giving up so that transient race doesn't need a human.
	async function createRelease(attempt = 1): Promise<void> {
		try {
			await run('gh', args)
			console.log(`${C.green('✓')} GitHub release ${tag} created`)
		} catch (err) {
			if (attempt === 1) {
				console.log(
					C.dim('  gh release create failed — retrying once (remote may lag)…'),
				)
				return createRelease(2)
			}
			// Surface the ACTUAL failure and a ready-to-paste retry instead of a
			// vague "may already exist" — the earlier swallowed error is why this
			// step was impossible to debug.
			console.log(C.yellow(`⚠ gh release failed: ${(err as Error).message}`))
			console.log(
				C.dim('  Retry manually (safe — nothing else is left to do):'),
			)
			console.log(
				C.dim(
					`    gh release create ${tag} --title "maxstack ${version}" --target ${branch}` +
						`${notesFile ? ` --notes-file ${notesFile}` : ' --generate-notes'}`,
				),
			)
		}
	}
	await createRelease()
} else {
	console.log(C.dim('  skipped.'))
}

console.log(`\n${C.green(C.bold(`✔ maxstack ${version} released.`))}`)
rl.close()
