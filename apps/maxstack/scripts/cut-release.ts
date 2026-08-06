/**
 * Cut a release in one command — and without ever talking to npm.
 *
 *   pnpm release patch        # or minor | major | 1.2.3
 *   pnpm release patch --dry-run
 *
 * All this does is move the version: it bumps the two version sites in lockstep,
 * commits `chore(release): maxstack@X.Y.Z`, tags `vX.Y.Z`, and pushes. The tag
 * push triggers `.github/workflows/release.yml`, which builds, packs, smoke
 * tests, and publishes `maxstack-runtime` then `maxstack` with npm trusted
 * publishing (OIDC). No `npm login`, no OTP, no token on this machine —
 * see `maxstack/docs/development.md` → "Cutting a release".
 *
 * Deliberately non-interactive: it never reads stdin, so it behaves the same in
 * a terminal, a pipe, or a task runner. Everything the old interactive flow
 * *asked* about is a precondition here — a dirty tree, drifted version sites, a
 * version already on the registry or already tagged all ABORT rather than
 * prompt. `scripts/publish.ts` remains the break-glass path that publishes from
 * a laptop when Actions is unavailable.
 */

import { spawn } from 'node:child_process'
import { readFile, writeFile } from 'node:fs/promises'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { webRepo } from './changelog.ts'

const appDir = resolve(dirname(fileURLToPath(import.meta.url)), '..')
// Every git command below runs here: the root of the repository that
// `release.yml` lives in and that npm's trusted publisher names. This used to
// point one level higher, back when this tree was a subdirectory of the private
// repo — after the split that aimed the whole release at the wrong repository,
// which is why the preconditions below now check `origin` rather than trusting
// this path arithmetic.
const maxstackRoot = resolve(appDir, '../..')

const argv = process.argv.slice(2)
const dryRun = argv.includes('--dry-run')
const spec = argv.find((a) => !a.startsWith('-'))

const C = {
	dim: (s: string) => `\x1b[2m${s}\x1b[0m`,
	bold: (s: string) => `\x1b[1m${s}\x1b[0m`,
	green: (s: string) => `\x1b[32m${s}\x1b[0m`,
	red: (s: string) => `\x1b[31m${s}\x1b[0m`,
}

function abort(msg: string): never {
	console.error(`\n${C.red('✗')} ${msg}`)
	process.exit(1)
}

function run(cmd: string, args: string[], cwd = maxstackRoot): Promise<void> {
	console.log(C.dim(`  $ ${cmd} ${args.join(' ')}`))
	if (dryRun) return Promise.resolve()
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

/** Capture stdout (trimmed). Never throws — a failed command reads as ''. */
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

/** `git@github.com:x/y.git`, `https://github.com/x/y` → `github.com/x/y`. */
function normalizeRepo(url: string): string {
	return url
		.trim()
		.replace(/^git\+/, '')
		.replace(/^\w+:\/\//, '')
		.replace(/^git@/, '')
		.replace(/^([^/:]+):/, '$1/')
		.replace(/\.git$/, '')
		.replace(/\/$/, '')
		.toLowerCase()
}

function bump(v: string, kind: 'major' | 'minor' | 'patch'): string {
	const m = v.match(/^(\d+)\.(\d+)\.(\d+)/)
	if (!m) abort(`current version "${v}" is not a semver x.y.z.`)
	let [maj, min, pat] = [Number(m[1]), Number(m[2]), Number(m[3])]
	if (kind === 'major') [maj, min, pat] = [maj + 1, 0, 0]
	else if (kind === 'minor') [min, pat] = [min + 1, 0]
	else pat += 1
	return `${maj}.${min}.${pat}`
}

if (!spec) {
	abort(
		'usage: pnpm release <patch|minor|major|x.y.z> [--dry-run]\n' +
			'  bumps both version sites, commits, tags and pushes; CI publishes.',
	)
}

// ── the two version sites, which must already agree ──────────────────────────
const pkgPath = resolve(appDir, 'package.json')
const cliPath = resolve(appDir, 'src/program.ts')
const pkg = JSON.parse(await readFile(pkgPath, 'utf8'))
const current: string = pkg.version
let cliSrc = await readFile(cliPath, 'utf8')
const declared = cliSrc.match(/CLI_VERSION = ['"]([^'"]+)['"]/)?.[1]
if (declared !== current) {
	abort(
		`version sites disagree: package.json is ${current}, src/program.ts declares ${declared ?? '?'}.\n` +
			'  Reconcile them first — they ship as one version.',
	)
}

const version =
	spec === 'patch' || spec === 'minor' || spec === 'major'
		? bump(current, spec)
		: spec.replace(/^v/, '')
if (!/^\d+\.\d+\.\d+$/.test(version))
	abort(`"${spec}" is neither patch/minor/major nor a semver x.y.z.`)
if (version === current)
	abort(`${version} is already the committed version — pick a higher one.`)
const tag = `v${version}`

// ── preconditions: every one of these used to be a y/N prompt ────────────────
// Which repository are we about to tag? `release.yml` only exists in the public
// repo, and npm's trusted publisher names that repo specifically — so a tag
// pushed anywhere else publishes nothing and looks like a successful release.
// This tree has been a subdirectory of another repo before; assert, don't infer.
const originUrl = await capture('git', ['remote', 'get-url', 'origin'])
const expected = webRepo(pkg.repository)
if (!originUrl) abort('no `origin` remote here — nothing to push a tag to.')
if (expected && normalizeRepo(originUrl) !== normalizeRepo(expected))
	abort(
		`origin is ${originUrl}\n` +
			`  but package.json says this ships from ${expected}.\n` +
			'  Only the repo holding .github/workflows/release.yml can publish — a tag\n' +
			'  pushed anywhere else does nothing at all.',
	)

const branch = await capture('git', ['rev-parse', '--abbrev-ref', 'HEAD'])
if (branch !== 'main')
	abort(
		`releases are cut from main; you are on "${branch}".\n` +
			'  The workflow publishes what the tag points at — merge first.',
	)

const dirty = await capture('git', ['status', '--porcelain'])
if (dirty)
	abort(
		`the checkout has ${dirty.split('\n').length} uncommitted path(s).\n` +
			'  Release from a clean tree so the tag names exactly what CI will build.',
	)

const behind = await capture('git', [
	'rev-list',
	'--count',
	`HEAD..origin/${branch}`,
])
if (behind && behind !== '0')
	abort(
		`origin/${branch} is ${behind} commit(s) ahead — pull first (run \`git fetch origin\` if this is stale).`,
	)

if (await capture('git', ['tag', '--list', tag]))
	abort(`tag ${tag} already exists locally — that version was already cut.`)
if (await capture('git', ['ls-remote', '--tags', 'origin', tag]))
	abort(`tag ${tag} already exists on origin — that version was already cut.`)

for (const name of ['maxstack', 'maxstack-runtime']) {
	const onNpm = await capture('npm', ['view', `${name}@${version}`, 'version'])
	if (onNpm === version)
		abort(
			`${name}@${version} is already on the registry — npm never lets a version be replaced.`,
		)
}

console.log(
	`\n${C.bold('release plan')}${dryRun ? C.dim('  (dry run — nothing will be written)') : ''}\n` +
		`  version   ${C.bold(current)} → ${C.bold(version)}\n` +
		`  writes    apps/maxstack/package.json, apps/maxstack/src/program.ts\n` +
		`  commit    chore(release): maxstack@${version}\n` +
		`  tag       ${tag}  ${C.dim('(pushing it triggers .github/workflows/release.yml)')}\n` +
		`  publishes ${C.dim('maxstack-runtime then maxstack, on the runner, via OIDC — not here')}\n`,
)

if (dryRun) {
	console.log(C.dim('  dry run: no files written, nothing pushed.'))
	process.exit(0)
}

// ── write, commit, tag, push ────────────────────────────────────────────────
pkg.version = version
await writeFile(pkgPath, `${JSON.stringify(pkg, null, '\t')}\n`)
cliSrc = cliSrc.replace(/(CLI_VERSION = ['"])[^'"]+(['"])/, `$1${version}$2`)
await writeFile(cliPath, cliSrc)
console.log(`${C.green('✓')} bumped both version sites to ${C.bold(version)}`)

await run('git', [
	'add',
	'apps/maxstack/package.json',
	'apps/maxstack/src/program.ts',
])
await run('git', ['commit', '-m', `chore(release): maxstack@${version}`])
await run('git', ['tag', tag])
// Push the branch BEFORE the tag: the workflow's GitHub release targets the
// tagged SHA, and a tag whose commit is not on the branch is an orphan release.
await run('git', ['push', 'origin', branch])
await run('git', ['push', 'origin', tag])

const repo =
	(await capture('gh', ['repo', 'view', '--json', 'url', '-q', '.url'])) ||
	'https://github.com/sys13/maxstack'
console.log(
	`\n${C.green(C.bold(`✔ ${tag} pushed.`))} CI is cutting the release now:\n` +
		`  ${repo}/actions/workflows/release.yml\n` +
		C.dim(
			'  watch it with: gh run watch $(gh run list -w release.yml -L1 --json databaseId -q ".[0].databaseId")\n',
		),
)
