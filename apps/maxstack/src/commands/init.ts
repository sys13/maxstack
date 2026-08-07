/**
 * `maxstack init [dir]` — scaffold a standalone maxstack project: a
 * `maxstack.json` config, a seeded `spec/` directory, the generated app tree, and a
 * `package.json` whose `validate` gate runs green standalone. This is the
 * primitive that unlocks the real `--gate "pnpm validate"` nightly (task 9/10
 * IOU): the generated tree is a package that validates on its own.
 */

import { basename, resolve } from 'node:path'
import { previewInstall } from '@maxstack/features/bundle'
import { writeSpecDir } from '@maxstack/mcp'
import {
	cliDependencyRange,
	cliVersion,
	PINNED_DEP,
	warnOnPathCliMismatch,
} from '../lib/cli-resolution.ts'
import { renderEnvExample, renderEnvLocal } from '../lib/env-scaffold.ts'
import { generateProject } from '../lib/generate.ts'
import {
	bootstrapRepo,
	type GitBootstrap,
	gitBootstrapNotice,
} from '../lib/git.ts'
import { type CliInvocation, currentInvocation } from '../lib/invocation.ts'
import { writeMcpJson } from '../lib/mcp-config.ts'
import { HUB_ROOT } from '../lib/paths.ts'
import { runPreflight } from '../lib/preflight.ts'
import {
	CONFIG_FILENAME,
	DEFAULT_CONFIG,
	loadProject,
	type Project,
	type ProjectConfig,
	SPEC_DIRNAME,
	saveConfig,
	seedSpec,
} from '../lib/project.ts'
import { renderTemplate } from '../lib/render.ts'
import { addCommand, renderPreview } from './add.ts'

interface InitOptions {
	desc?: string
	backend?: string
	/** Emit preflight diagnostics as JSON instead of the human report. */
	preflightJson?: boolean
	/** Skip `git init` + the scaffold commit. */
	git?: boolean
	/** Comma-separated bundle slugs to install while scaffolding. */
	with?: string
	/** With `--with`: preview only, scaffold nothing. */
	dryRun?: boolean
}

interface InitPrompts {
	projectName?: () => Promise<string>
}

/** What {@link scaffoldProject} wrote — enough for a caller to report it
 * without re-reading the tree. */
export interface ScaffoldResult {
	root: string
	project: Project
	config: ProjectConfig
	invocation: CliInvocation
	writes: Awaited<ReturnType<typeof generateProject>>['writes']
	artifacts: Awaited<ReturnType<typeof generateProject>>['artifacts']
	/** Whether the scaffold now has version control behind it. */
	git: GitBootstrap
}

/**
 * Write a fresh maxstack project to `root` and generate its initial app tree.
 *
 * Split out of {@link initCommand} for `maxstack start`, which
 * needs the identical scaffold but prints a different story on top of it — the
 * one thing `start` must not become is a second, subtly-divergent `init`. This
 * function writes and returns; every line of terminal output belongs to the
 * caller.
 */
export async function scaffoldProject(opts: {
	root: string
	name: string
	desc?: string
	backend?: string
	preflightJson?: boolean
	/** Skip the git bootstrap. Off by default, and loudly. */
	noGit?: boolean
}): Promise<ScaffoldResult> {
	const { mkdir, writeFile } = await import('node:fs/promises')
	const root = resolve(opts.root)
	const name = opts.name
	const packageName = kebabCase(name)

	// Preflight: the Node floor and the already-a-project refusal,
	// before anything is written. Both used to surface as a bare throw — one of
	// them as a `SyntaxError` from inside the bundle.
	await runPreflight('init', root, { json: opts.preflightJson })

	const config: ProjectConfig = {
		...DEFAULT_CONFIG,
		name,
		backend: opts.backend === 'postgres' ? 'postgres' : 'pglite',
	}

	// How to invoke this CLI again, for the files that will do so later without a
	// shell around them (`.mcp.json`, the edit-guard hook) and for the commands
	// the scaffolded docs tell a human to run. A bare `maxstack` is only right
	// when one is on PATH, which under npx it is not.
	const invocation = await currentInvocation()

	await mkdir(root, { recursive: true })
	await saveConfig(root, config)
	await writeSpecDir(
		resolve(root, SPEC_DIRNAME),
		seedSpec(name, opts.desc ?? ''),
	)
	await writeFile(
		resolve(root, 'package.json'),
		await scaffoldPackageJson(packageName),
	)
	await writeFile(resolve(root, '.gitignore'), GITIGNORE)
	// The compiler config the scaffolded `typecheck` script needs. Without it
	// the script exists and cannot run, which is the same hollow green one step
	// removed.
	await writeFile(resolve(root, 'tsconfig.json'), TSCONFIG)
	// The configs the other three declared gates need, for the same reason
	// (#341). A script with no config behind it is the same hollow green: `lint`
	// with no `biome.jsonc` lints nothing, `e2e` with no `playwright.config.ts`
	// has no `baseURL` for `page.goto('/')` and no server to point it at, and
	// `test` with no `vitest.config.ts` would sweep the Playwright specs into a
	// runner that cannot execute them.
	await writeFile(resolve(root, 'biome.jsonc'), BIOME_CONFIG)
	await writeFile(resolve(root, 'vitest.config.ts'), VITEST_CONFIG)
	await writeFile(resolve(root, 'playwright.config.ts'), PLAYWRIGHT_CONFIG)
	await writeFile(resolve(root, 'README.md'), readme(name, config, invocation))
	// Always-on cold-start signal: a fresh agent dropped into this
	// project must know — before its first sentence, with no server running —
	// that the app is grown through the typed spec, not hand-written. CLAUDE.md
	// at the root is the only layer loaded unconditionally at session start.
	await writeFile(
		resolve(root, 'CLAUDE.md'),
		claudeMd(name, config, invocation),
	)

	// Secrets, not defaults: write the committed `.env.example` contract and a
	// gitignored `.env` whose secret slots (BETTER_AUTH_SECRET, …) are filled
	// with cryptographically-random values, so a fresh project never signs
	// sessions with the runtime's hardcoded dev fallback.
	await writeFile(resolve(root, '.env.example'), renderEnvExample())
	await writeFile(resolve(root, '.env'), renderEnvLocal())

	// The hybrid-onboarding gap: drop `.mcp.json` plus the
	// spec-driven skills, so `cd && claude` just works — the MCP server
	// auto-registers and the skills auto-load, no `claude mcp add`, no
	// hand-editing config.
	//
	// Both files re-invoke this CLI later, from a process we don't control, so
	// they must name an invocation that resolves for the way it is installed
	// *now* — under `npx` there is no `maxstack` on PATH, and a bare one made the
	// scaffold come out pre-broken.
	await writeMcpJson(root)
	const sharedClaude = resolve(HUB_ROOT, 'templates', '_shared', '.claude')
	await renderTemplate(sharedClaude, resolve(root, '.claude'), {
		NAME: name,
		MAXSTACK_BIN: invocation.shell,
	})

	// Generate the initial app tree so the fresh project already validates.
	const project = await loadProject(root)
	const { writes, artifacts } = await generateProject(project)

	// Version control, last, so the first commit contains the whole scaffold
	//. Never-clobber is the safety story for owned code, and its
	// recovery path is `git diff` / `git checkout --`. Writing a `.gitignore`
	// for a repo that does not exist was the tell that the precondition was
	// being left to the user's habits.
	const git: GitBootstrap = opts.noGit
		? { status: 'unavailable', reason: 'skipped with --no-git' }
		: await bootstrapRepo(root)

	return { root, project, config, invocation, writes, artifacts, git }
}

export async function initCommand(
	dir: string | undefined,
	opts: InitOptions,
	prompts: InitPrompts = {},
): Promise<void> {
	const selected = (opts.with ?? '')
		.split(',')
		.map((slug) => slug.trim())
		.filter(Boolean)

	// Module selection at init: prerequisites are resolved and
	// **shown before anything is written**, so "billing needs auth" is a thing
	// the user reads and then agrees to, rather than something they discover in
	// a diff afterwards. A refusal (an unknown slug) also lands here, before a
	// directory exists — the point of previewing at all.
	const preview = selected.length
		? previewInstall(seedSpec('preview', ''), selected)
		: null
	if (preview) {
		console.log(`\n${renderPreview(preview)}\n`)
		if (preview.errors.length)
			throw new Error(
				`refusing to scaffold: ${preview.errors.join('; ')}. ` +
					'Run "maxstack add" with no arguments to browse the catalog.',
			)
		if (opts.dryRun) {
			console.log('  (dry run — nothing was scaffolded)\n')
			return
		}
	}

	const projectName = dir
		? basename(resolve(dir)) || 'maxstack-app'
		: await (prompts.projectName ?? promptForProjectName)()
	const target = dir ?? kebabCase(projectName)
	const name = projectName

	const { root, invocation, writes, artifacts, git } = await scaffoldProject({
		root: resolve(target),
		name,
		desc: opts.desc,
		backend: opts.backend,
		preflightJson: opts.preflightJson,
		// Commander's `--no-git` sets `git: false`.
		noGit: opts.git === false,
	})

	// Install the selected modules through the ordinary `add` path.
	// Deliberately not a bespoke bulk installer: "select several at init" has to
	// produce the same project as "add them one at a time", and the cheapest way
	// to guarantee that is for it to *be* the same code. The #194 lattice gate
	// then covers this path for free.
	for (const slug of preview?.order ?? []) {
		await addCommand(root, slug)
	}

	// `cd` hint: honor whatever the user targeted (arg or prompt answer), but
	// stay quiet when they landed in the current directory.
	const where = root === resolve('.') ? '.' : target

	// #331: what to type next is the first thing on the screen, and very nearly
	// the only thing on it. This used to open with a twelve-row inventory of
	// every file the scaffold wrote — reference material, answering a question
	// nobody has in the second after running `init`, and pushing the two commands
	// that matter to the bottom of a screenful. The inventory did not disappear:
	// it lives in the generated README, under `## Layout`, where it is findable
	// at the moment it is actually wanted.
	//
	// The receipt is two lines. The name (with the description folded in when
	// there is one, so confirming the input costs no extra line), then the
	// absolute root: `init` with no argument derives the directory from the
	// answered name, so where the project now lives is the one thing a first-time
	// user cannot infer from what they typed.
	console.log(
		`\n  ${green(glyphs.check)}  ${bold(name)}  ${dim(`${glyphs.dash} ${opts.desc || 'maxstack project ready'}`)}`,
	)
	console.log(`     ${dim(root)}`)

	// Issue #264. Never-clobber promises the platform will not overwrite code
	// you own; the thing that makes a mistake survivable is being able to diff
	// and revert. If that is missing, the user has to hear it now — not at the
	// moment they need it.
	const gitNotice = gitBootstrapNotice(git)
	if (gitNotice) console.warn(`\n  ! ${gitNotice}`)

	// The agent-driven path is a single step: `.mcp.json` registers a stdio
	// server the client starts itself, so there's no "start dev first, in
	// another shell, before the session" ordering left to get wrong — which is
	// why the MCP registration no longer needs a paragraph here.
	console.log()
	console.log(
		steps([
			...(where !== '.' ? ([[`cd ${where}`, '']] as [string, string][]) : []),
			[
				'claude',
				'describe what you want built — the maxstack tools are already there',
			],
		]),
	)
	// The two follow-ons, one line each: the server, and where the detail went.
	console.log(
		`\n  ${dim('or run it yourself:')} ${cyan(`${invocation.shell} dev`)} ${dim(`${glyphs.dash} the app at localhost:3000`)}`,
	)
	console.log(
		`  ${dim('what was scaffolded:')} ${cyan('README.md')} ${dim(`${glyphs.dash} ${count(writes.length, 'route write')} ${glyphs.mid} ${count(artifacts.length, 'artifact')} generated`)}\n`,
	)

	// Issue #131: a config that invokes `maxstack` by name resolves to whatever
	// global the user happens to have, which may predate the verbs it names —
	// silently. Scaffold time is the moment a human can fix it. Under npx we
	// wrote a version-pinned `npx` invocation instead, which does not depend on
	// PATH at all, so the warning would be advice to fix a problem we don't have.
	if (invocation.command === 'maxstack') await warnOnPathCliMismatch()
}

// --- terminal styling ------------------------------------------------------
// A tiny ANSI + glyph layer instead of a color dependency. Color is suppressed
// when output isn't a TTY (pipes, CI, the test mocks) or NO_COLOR is set, so
// piped output stays clean plain text. Box-drawing glyphs fall back to ASCII
// when the locale isn't UTF-8 (e.g. LANG=C), so a legacy shell never renders
// mojibake.
const useColor = (): boolean =>
	Boolean(process.stdout.isTTY) && !process.env.NO_COLOR
const wrap =
	(open: number, close: number) =>
	(s: string): string =>
		useColor() ? `\x1b[${open}m${s}\x1b[${close}m` : s
const dim = wrap(2, 22)
const bold = wrap(1, 22)
const green = wrap(32, 39)
const cyan = wrap(36, 39)

const isUtf8 = (): boolean => {
	const enc = process.env.LC_ALL || process.env.LC_CTYPE || process.env.LANG
	return !enc || /utf-?8/i.test(enc)
}
const glyphs = {
	get check() {
		return isUtf8() ? '✔' : 'ok'
	},
	get mid() {
		return isUtf8() ? '·' : '-'
	},
	get dash() {
		return isUtf8() ? '—' : '--'
	},
}

/** Pluralize a labeled count: `count(1, 'artifact')` → `1 artifact`. */
function count(n: number, noun: string): string {
	return `${n} ${noun}${n === 1 ? '' : 's'}`
}

/**
 * Render copy-paste command hints: an indented command with an aligned `#`
 * comment. Kept decoration-free (no surrounding box or gutter) so a full-block
 * paste runs cleanly in any shell — the `#` turns each note into a shell
 * comment, and leading whitespace is ignored.
 */
function steps(rows: [cmd: string, note: string][]): string {
	// Align comments only across commands that carry one, so a long argument-
	// free line (e.g. `cd <long path>`) doesn't push every comment off-screen.
	const width = Math.max(...rows.filter(([, n]) => n).map(([c]) => c.length))
	return rows
		.map(([cmd, note]) =>
			note
				? `    ${cyan(cmd.padEnd(width))}  ${dim(`# ${note}`)}`
				: `    ${cyan(cmd)}`,
		)
		.join('\n')
}

/**
 * Ask for a human-facing project name, then let `init` derive the default
 * scaffold directory (`./<kebab-case-name>`) from it. Non-interactive stdin
 * (a pipe, CI) skips the prompt and falls back to the current directory name.
 */
async function promptForProjectName(): Promise<string> {
	const cwdName = basename(process.cwd()) || 'maxstack-app'
	if (!process.stdin.isTTY) return cwdName

	const { createInterface } = await import('node:readline/promises')
	const rl = createInterface({ input: process.stdin, output: process.stdout })
	try {
		const answer = await rl.question(
			`What should the project be called? [${cwdName}] `,
		)
		return answer.trim() || cwdName
	} finally {
		rl.close()
	}
}

function kebabCase(name: string): string {
	return (
		name
			.toLowerCase()
			.trim()
			.replace(/[^a-z0-9]+/g, '-')
			.replace(/^-+|-+$/g, '') || 'maxstack-app'
	)
}

export async function scaffoldPackageJson(name: string): Promise<string> {
	// Pin the maxstack toolchain the scripts drive as devDependencies at this
	// CLI's own version: `maxstack` (the CLI) and `maxstack-runtime` (the web
	// runtime `dev`/`build` need). Both are published, so `pnpm install` here
	// provides the whole toolchain locally instead of assuming a global install
	// or a maxstack checkout on PATH. `dev` needs no `MAXSTACK_DATA_DIR` prefix:
	// `maxstack dev` reads the data dir from `maxstack.json` and resolves it itself.
	const version = await cliVersion()
	const raw = await scaffoldOverrides()
	const overrides = Object.keys(raw).length > 0 ? raw : null
	const pkg = {
		name,
		version: '0.0.0',
		private: true,
		type: 'module',
		scripts: {
			gen: 'maxstack gen',
			op: 'maxstack op',
			add: 'maxstack add',
			eject: 'maxstack eject',
			validate: 'maxstack validate',
			upgrade: 'maxstack gen --upgrade',
			dev: 'maxstack dev',
			// `maxstack validate` and the MCP `run_checks` tool look for these by
			// name and report each missing one as UNEXAMINED. A
			// scaffold that omits `typecheck` is a scaffold whose gate goes green
			// having never opened a line of the code its owner writes — and typed
			// slot props are decoration if nothing ever runs the compiler over them.
			typecheck: 'tsc --noEmit',
			// The other three, for the same reason (#341). `typecheck` was the only
			// one of the four that ever got the follow-through, so `validate` on a
			// fresh project reported three checks UNEXAMINED — and the sharpest of
			// them was `e2e`: `maxstack gen` transcribes every page's `e2eTests`
			// into a Playwright spec and then nothing on the path from `init` to
			// `validate` could open it.
			//
			// `--passWithNoTests` because a project that has not written a unit test
			// yet has not failed one. What keeps that from becoming a false green is
			// on the reporting side, not here: `project-checks.ts` reports `test` as
			// UNEXAMINED when the project has no test files, so an empty suite is
			// named rather than counted as a pass.
			lint: 'biome check .',
			test: 'vitest run --passWithNoTests',
			e2e: 'playwright test',
		},
		devDependencies: {
			maxstack: `^${version}`,
			'maxstack-runtime': `^${version}`,
			typescript: '^5.9.0',
			// What the code in `app/` actually imports, and therefore what the
			// scaffolded `typecheck` script needs on disk to mean anything (#347).
			//
			// `react` + `@types/react`: every route module and every user-owned
			// `*.slots.tsx` is JSX. Without them `tsc` cannot resolve
			// `react/jsx-runtime`, so every element in the one file the user
			// actually writes is `any` — the gate runs, passes, and has checked
			// nothing. `@playwright/test`: `maxstack gen` writes Playwright specs
			// into `app/e2e/`, which are the author's from the moment they land.
			//
			// The `@maxstack/*` packages those files also import are NOT here, and
			// cannot be: they are workspace-internal and unpublished. `tsconfig`'s
			// `paths` points them at the source snapshot `maxstack-runtime` already
			// ships — see RUNTIME_TYPE_PATHS.
			react: '^19.2.8',
			'@types/react': '^19.2.17',
			'@playwright/test': '^1.62.0',
			// A job handler, a source refiner and an import parser are server code,
			// and so is every module of the runtime snapshot `tsconfig`'s `paths`
			// send the compiler into. Without this the type surface those files sit
			// on does not compile at all.
			'@types/node': '^26.1.1',
			// What the `lint` and `test` scripts are (#341). Biome because it is
			// one binary with no plugin graph to keep in sync, and because it is
			// what this repo lints itself with, so a report a user brings back is a
			// report we can read. Vitest because `maxstack-runtime` already carries
			// vite, so the runner a project reaches for is the one its own toolchain
			// is built on.
			// Exact, not caret. Biome compares the `$schema` its config names
			// against its own version and prints a "does not match" notice on every
			// run when they differ — a caret range floats to the next patch and the
			// scaffolded `pnpm lint` starts nagging about a file the user never
			// wrote. One constant feeds both, so they cannot drift.
			'@biomejs/biome': BIOME_VERSION,
			vitest: '^4.1.10',
		},
		...(overrides ? { overrides } : {}),
	}
	return `${JSON.stringify(pkg, null, '\t')}\n`
}

/**
 * The `overrides` block a scaffolded project declares — one entry.
 *
 * `better-auth`, which the runtime loads at boot, and its
 * `@better-auth/drizzle-adapter` both declare `drizzle-orm` as a *peer* at a
 * range (`^0.45.2`) that the copy we ship (`1.0.0-rc.4`) does not satisfy. Left
 * alone, npm resolves that by installing a **second**, older `drizzle-orm` at the
 * root purely to satisfy the peer, and nesting ours under `maxstack-runtime`.
 *
 * That second copy exists by no dependency edge — only npm's peer auto-install
 * put it there. Install *from the lockfile it produced* (a clone, a teammate's
 * checkout, a CI checkout) and npm prunes it, because pruning walks edges. The
 * app then dies before serving a page with `Cannot find package 'drizzle-orm'
 * imported from .../@better-auth/drizzle-adapter/dist/index.mjs` — naming a
 * package the user never chose and cannot find in their own manifest.
 *
 * The override collapses the tree to the single `drizzle-orm` the runtime
 * actually depends on, which is reachable by a real edge and therefore survives
 * any install. It is also the arrangement everything here is *tested* against:
 * pnpm links our copy into the adapter and always has, so the two-copy npm tree
 * was the odd one out, running the adapter against a drizzle no test ever saw.
 *
 * The override must cover `better-auth` too, not just the adapter — scoping it
 * to `@better-auth/drizzle-adapter` alone leaves better-auth's own peer
 * declaration conflicting and npm fails the install outright with ERESOLVE.
 *
 * Returns `{}` when the pin can't be read (an unusual install layout): a wrong
 * range here breaks `npm install` outright, which is worse than the bug.
 */
export async function scaffoldOverrides(): Promise<Record<string, string>> {
	const pinned = await cliDependencyRange(PINNED_DEP)
	return pinned ? { [PINNED_DEP]: pinned } : {}
}

/** This CLI's published version, read from its own `package.json` — used to pin
 * the toolchain a scaffolded project declares. Falls back to a caret-any range
 * if the manifest can't be read (an unusual install layout). */
// Ignore the local `.env` (holds the generated secrets) but keep the committed
// `.env.example` contract tracked.
// `test-results/` and `playwright-report/` are what a failing `pnpm e2e` leaves
// behind — traces and screenshots, useful for the next ten minutes and never
// again. Committing them was the alternative, and it is not one.
const GITIGNORE = `node_modules\n.maxstack\ndist\n.env\n.env.*\n!.env.example\ntest-results\nplaywright-report\n`

/**
 * The `lint` script's config (#341).
 *
 * **The formatter is off, deliberately.** Turn it on and `pnpm lint` fails on
 * `app/routes.ts` and `app/generated/types.ts` — files stamped DO NOT EDIT,
 * emitted by ts-morph, which biome would print back with different line breaks.
 * A gate the user cannot make green without ejecting from the framework is worse
 * than no gate: it teaches them the gate is noise, and then the real finding
 * arrives in the same colour. Style over generated output is our problem, not
 * theirs; the linter here is for correctness over the code they own.
 *
 * With the formatter off, `preset: recommended` runs clean over the whole
 * generated tree — the last exception was the unused `Slot` import every
 * zero-slot route module carried, fixed in #346, and the unused `expect` in the
 * generated Playwright specs, fixed here by giving the stub a real assertion.
 *
 * `node_modules` and `.maxstack` are excluded because biome would otherwise walk
 * the vendored runtime snapshot, which is this repo's source and not the user's.
 */
export const BIOME_VERSION = '2.5.6'

const BIOME_CONFIG = `{
	"$schema": "https://biomejs.dev/schemas/${BIOME_VERSION}/schema.json",
	"files": {
		"includes": ["**", "!**/node_modules", "!**/.maxstack", "!**/dist", "!**/test-results", "!**/playwright-report"]
	},
	// Off on purpose — see the note in maxstack's init.ts. The generated route
	// modules are ts-morph output stamped DO NOT EDIT; format-checking them makes
	// \`pnpm lint\` red on files you are not allowed to touch. Turn it on if you
	// would rather own that, and run \`biome check --write .\` after every \`gen\`.
	"formatter": { "enabled": false },
	"linter": { "enabled": true, "rules": { "preset": "recommended" } }
}
`

/**
 * The `test` script's config (#341).
 *
 * The one load-bearing line is `include`. Vitest's default sweep picks up
 * \`*.spec.ts\` as well as \`*.test.ts\`, which would collect the Playwright specs
 * `maxstack gen` writes into `app/e2e/` and run them under a runner that has no
 * browser to give them — a wall of "test is not defined"-shaped failures in
 * files the user did not write, on a script they just declared.
 *
 * So the split is by suffix, and it is a convention worth knowing:
 * **`.test.ts` is vitest, `.spec.ts` is Playwright.**
 */
const VITEST_CONFIG = `import { defineConfig } from 'vitest/config'

// \`.test.ts\` is vitest; \`.spec.ts\` is Playwright (\`app/e2e/\`, run by \`pnpm e2e\`).
// Without this split vitest would collect the Playwright specs and fail on them.
export default defineConfig({
	test: { include: ['app/**/*.test.ts', 'app/**/*.test.tsx'] },
})
`

/**
 * The `e2e` script's config (#341) — the missing end of the
 * declare -> generate -> run chain.
 *
 * A page's `e2eTests` are transcribed into `app/e2e/*.spec.ts` by `maxstack
 * gen`, and every one of those bodies opens with `page.goto('/some-route')` — a
 * relative URL, which means nothing without a `baseURL`, against a server
 * nobody started. Both halves are here: `webServer` runs the project's own `dev`
 * script, and `use.baseURL` names the address it binds.
 *
 * `PORT` rather than a literal so the two cannot drift: `maxstack dev` reads it,
 * and the same value builds the URL Playwright waits on and navigates against.
 * 3100, not 3000, so running `pnpm e2e` does not fight a `maxstack dev` the user
 * already has open in another terminal — and `reuseExistingServer` outside CI so
 * that if they *do* have one on 3100, the suite uses it instead of failing to
 * bind.
 *
 * `/health` as the readiness URL rather than `/`: the app's own root is a page
 * the user's spec defines and may legitimately redirect or 404 while they are
 * mid-change, and a readiness probe that depends on the thing under test cannot
 * tell "not up yet" from "broken".
 */
const PLAYWRIGHT_CONFIG = `import { defineConfig } from '@playwright/test'

// The runner behind \`pnpm e2e\`. The specs in app/e2e/ are scaffolded from each
// page's declared \`e2eTests\` by \`maxstack gen\` and are yours to fill in from
// the moment they land — \`gen\` never overwrites one that already exists.
const PORT = Number(process.env.PORT ?? 3100)

export default defineConfig({
	testDir: './app/e2e',
	reporter: [['list']],
	use: {
		// What makes \`page.goto('/decks')\` in a generated spec mean anything.
		baseURL: \`http://127.0.0.1:\${PORT}\`,
		trace: 'retain-on-failure',
	},
	projects: [{ name: 'chromium', use: { browserName: 'chromium' } }],
	webServer: {
		command: 'npm run dev',
		// Not '/' — the root is a page your spec owns, so it cannot double as the
		// readiness probe for the server that serves it.
		url: \`http://127.0.0.1:\${PORT}/health\`,
		reuseExistingServer: !process.env.CI,
		timeout: 180_000,
		env: { PORT: String(PORT) },
	},
})
`

/**
 * Where `tsc` in a scaffolded project finds the `@maxstack/*` types the code in
 * `app/` imports — the fix for #347, where a project with one entity failed its
 * own `typecheck` script with two dozen unresolved-module errors.
 *
 * Those packages are workspace-internal and are not published to npm, so
 * "declare them as dependencies" is not an option that exists. What *is*
 * published is `maxstack-runtime`, which already ships the whole workspace as a
 * source snapshot under `workspace/` (it is the tree `maxstack build` vendors
 * from, and its layout mirrors the checkout exactly). Each package there carries
 * its own `exports` map, and — because the snapshot sits *inside* the
 * `maxstack-runtime` package directory — its own third-party imports resolve
 * against `maxstack-runtime`'s dependencies under both npm's hoisted layout and
 * pnpm's strict one. So the types are already on disk after `install`; all that
 * was missing was telling the compiler where.
 *
 * Mapping rather than rewriting the generated imports is deliberate. The emitted
 * specifier stays `@maxstack/ui`, which is what it must be for the vendored
 * build that actually compiles these files — this table only affects the
 * project's own `tsc` run.
 *
 * Keys are every non-relative `@maxstack/*` specifier the generators emit into a
 * project tree (`packages/maxstack-core/src/ownership/`: routes and block slots
 * import from `@maxstack/ui`, import parsers from `@maxstack/core`, schedule
 * handlers and source refiners from `@maxstack/features/*`). A new seam that
 * emits a new specifier must be added here or the project it generates into
 * stops typechecking — `scaffold-typecheck.test.ts` runs the compiler over a
 * tree built by the real emitters, so the two halves cannot drift apart.
 */
export const RUNTIME_TYPE_PATHS: Record<string, string> = {
	// What the generated and owned files themselves import.
	'@maxstack/ui': 'packages/ui/src/index.ts',
	'@maxstack/core': 'packages/maxstack-core/src/index.ts',
	'@maxstack/features/*': 'packages/features/src/*/index.ts',
	// Not imported by a project — imported by the three above. The compiler
	// follows a mapped specifier into real source, so the snapshot's own
	// cross-package imports have to resolve as well or the user sees the failure
	// as dozens of errors inside `node_modules`.
	'@maxstack/spec': 'packages/spec/src/index.ts',
	'@maxstack/spec-derive': 'packages/spec-derive/src/index.ts',
}

/** The `paths` block {@link RUNTIME_TYPE_PATHS} becomes, rooted at the installed
 * runtime's source snapshot. */
export function runtimeTypePaths(): Record<string, string[]> {
	return Object.fromEntries(
		Object.entries(RUNTIME_TYPE_PATHS).map(([specifier, file]) => [
			specifier,
			[`./node_modules/maxstack-runtime/workspace/${file}`],
		]),
	)
}

/**
 * The compiler config behind the scaffolded `typecheck` script.
 *
 * Deliberately strict: the point of generating types for owned code is to turn
 * knowledge an agent would otherwise have to carry (hook shapes, resource names,
 * null-vs-empty-string payloads) into errors it cannot ignore, and a loose
 * config gives that up for nothing.
 *
 * `include` covers the whole app tree rather than only the user-owned files in
 * it. Narrowing it to `*.slots.tsx` &co was tempting — the gate is *for* owned
 * code — but ownership is a fact in the route manifest, not a fact about a path:
 * an ejected route keeps the file name the generated one had, so no glob can
 * tell them apart, and the narrow config would silently stop checking a file the
 * moment its owner took responsibility for it. Checking everything costs nothing
 * once the imports resolve, and a generated file that does not compile is a bug
 * in this repo that its user should not be the last to hear about.
 */
export const TSCONFIG = `${JSON.stringify(
	{
		compilerOptions: {
			target: 'ES2023',
			lib: ['ES2023', 'DOM', 'DOM.Iterable'],
			module: 'Preserve',
			moduleResolution: 'bundler',
			jsx: 'react-jsx',
			strict: true,
			noUncheckedIndexedAccess: true,
			verbatimModuleSyntax: true,
			noEmit: true,
			skipLibCheck: true,
			allowImportingTsExtensions: true,
			resolveJsonModule: true,
			paths: runtimeTypePaths(),
			// Spelled out rather than left to the automatic sweep of
			// `node_modules/@types`, because the two compilers a project can be
			// holding disagree about that sweep: TypeScript 5 picks `@types/node`
			// up on its own and TypeScript 7 does not, so an upgrade that should
			// have been invisible instead turns the runtime's server-side source
			// into a wall of "Cannot find name 'process'".
			types: ['node', 'react'],
		},
		// The root `*.config.ts` files too (#341): `vitest.config.ts` and
		// `playwright.config.ts` are the only reason `pnpm test` and `pnpm e2e`
		// run at all, and a typo in one of them is a gate that silently stops
		// covering anything.
		include: ['app/**/*.ts', 'app/**/*.tsx', '*.config.ts'],
	},
	null,
	'\t',
)}\n`

function readme(
	name: string,
	config: ProjectConfig,
	invocation: CliInvocation,
): string {
	const bin = invocation.shell
	return `# ${name}

A [maxstack](https://github.com/) project — an app grown change-by-change
through typed spec-ops and never-clobber regeneration.

## Layout

Everything \`${bin} init\` wrote, and why (#331 — this list used to print to the
terminal at scaffold time, where it answered a question nobody had yet):

- \`${CONFIG_FILENAME}\` — project config (app dir, data dir, backend, reviewMode)
- \`${SPEC_DIRNAME}/\` — the one-system spec, split by layer (product · data · pages · pricing · ledger · oplog)
- \`${config.appDir}/\` — generated route modules + user-owned slot stubs + manifest
- \`${config.dataDir}/\` — durable runtime state (created by \`${bin} dev\`)
- \`package.json\` — the pinned maxstack toolchain and the four gate scripts
- \`tsconfig.json\` — the compiler config behind \`typecheck\`, covering the code you own
- \`biome.jsonc\` · \`vitest.config.ts\` · \`playwright.config.ts\` — the lint · test · e2e gates
- \`.mcp.json\` — registers the MCP server over stdio, so \`mcp__maxstack__*\` loads
  in **every** agent session (it spawns \`${bin} mcp\`; nothing to start first)
- \`.claude/skills/\` — the spec-driven skills, auto-loaded
- \`.claude/settings.json\` — a hook that keeps agents off generated files
- \`CLAUDE.md\` — the agent cold-start briefing (spec-first, field types, owning a route)
- \`.env\` — generated secrets, gitignored · \`.env.example\` — the committed contract
- \`.git/\` — version control, with the whole scaffold in the first commit
  (skipped by \`--no-git\`, which leaves never-clobber with no undo behind it)

## Requirements

Node ≥ 22. Nothing else: this project was scaffolded with

\`\`\`sh
${bin}
\`\`\`

and every command below is written the same way, so none of them needs an install.

The \`maxstack\` CLI and \`maxstack-runtime\` are *also* pinned as devDependencies,
so \`pnpm install\` (or \`npm install\`) gives you the toolchain locally and lets you
drop the prefix: run \`pnpm run <script>\`, or put \`./node_modules/.bin\` on your
\`PATH\`. A global install (\`npm i -g maxstack\`) does the same for every project.

## Getting started

\`\`\`sh
${bin} dev${' '.repeat(Math.max(1, 25 - bin.length))}# keep running — serves the app at localhost:3000
claude                           # in any other shell — the MCP tools are always there
# then run /plan-and-scope to begin
\`\`\`

\`.mcp.json\` registers the MCP server over **stdio**, so your agent client starts
it itself: there is no ordering between \`claude\` and \`dev\` to get wrong.

Or evolve the spec straight from the terminal:

\`\`\`sh
${bin} add-entity task --field title:text! --field done:bool   # → a data.addEntity op
${bin} add-entity book --field title:text! --with-page         # entity + default page in one shot
${bin} add-field task 'priority:enum(low,med,high)'            # → a data.addField op
${bin} add-field task owner:ref:e-user                         # → a belongs-to reference
${bin} op --file change.json                                   # the raw wire format
${bin} eject <route-id>          # take whole-file ownership (--dry-run to preview)
${bin} validate                  # spec valid + manifest intact + regen stable
\`\`\`

Writes land + accept + regenerate in one shot: \`"reviewMode": "auto"\` is the
default this scaffold wrote into \`${CONFIG_FILENAME}\` (trusted-solo), and it settles by
write path, not by author — an agent driving the CLI lands accepted too. Set
\`"reviewMode": "review"\` there for the review-first loop, where those verbs queue in
\`/workbench\` and \`--accept --gen\` opts a single write back out.
\`${bin} dev\` regenerates the app tree automatically as the spec changes.

The \`validate\` gate is standalone: it checks the spec parses, the generated
files match the ownership manifest, and a fresh regeneration changes nothing you
own — the safe-change-over-time guarantee, enforced in CI. It then runs this
project's own four scripts over the code, and **names any it could not run**
rather than passing quietly:

\`\`\`sh
npm run typecheck                # tsc over app/, owned code included
npm run lint                     # biome (formatter off — see biome.jsonc)
npm run test                     # vitest over app/**/*.test.ts
npm run e2e                      # playwright over app/e2e/*.spec.ts
\`\`\`

\`app/e2e/*.spec.ts\` is scaffolded from each page's declared \`e2eTests\` and is
yours from the moment it lands — \`${bin} gen\` never overwrites one. The stubs
navigate and assert the page loaded; filling in the behaviour is the work.
\`npm run e2e\` needs browsers once: \`npx playwright install chromium\`.
Until then \`validate\` reports e2e as unexamined, which is what it is.

## When something looks wrong

\`\`\`sh
${bin} doctor                    # versions · runtime · store lock · dev server · MCP handshake
\`\`\`

Two different things can be broken, and telling them apart saves hours:

- **Your spec** decides *what exists* — entities, fields, pages, which columns a
  list shows. Wrong or missing content is a spec question; a spec-op fixes it.
- **The runtime** (\`maxstack-runtime\`, a prebuilt server shared by every
  maxstack project) decides *how it behaves* — rendering, form widgets, routing,
  auth, \`/api/<resource>\`. If a form mangles what you typed or a page misbehaves
  in a way no op explains, **that is a runtime bug, not your spec**: report it at
  https://github.com/sys13/maxstack/issues with your \`${bin} doctor\` output.
`
}

/**
 * The always-on briefing. This must communicate one thing before
 * an agent writes its first line of code: the app is grown through the typed
 * spec, never hand-written. A root `CLAUDE.md` is the only layer loaded
 * unconditionally at session start.
 *
 * Two things it must also do, learned from watching a real session get them
 * wrong with the tools sitting right there:
 *   - **Lead with MCP, unqualified.** The tools are now a stdio server the
 *     client spawns itself (`.mcp.json` → `maxstack mcp`), so they are present
 *     in every session — there is no cold start left to hedge against. The
 *     previous draft opened with the CLI and filed MCP under "only when dev is
 *     running", and agents dutifully read that as "the CLI is the way".
 *   - **State the facts that are otherwise only discoverable by reading
 *     runtime source.** A session burned ~18 shell commands rediscovering the
 *     field-type list (and still got it wrong — it guessed the CLI sugar
 *     `text` was canonical and missed `json`) and the owned-route contract.
 *     Both are fixed, cheap to write down, and expensive to reverse-engineer.
 */
function claudeMd(
	name: string,
	config: ProjectConfig,
	invocation: CliInvocation,
): string {
	const bin = invocation.shell
	return `# ${name}

**This is a [maxstack](https://github.com/) project. Read this before writing any code.**

The app under \`${config.appDir}/\` is **auto-generated** from the typed spec in
\`${SPEC_DIRNAME}/*.json\`. You grow the app by **changing the spec**, not by
hand-writing application files. Do not scaffold a fresh app, an HTML file, or a
new framework — the app already exists and is regenerated from the spec.

> **Building or changing anything here? Use the \`build-app\` skill.** It carries
> the whole loop — spec ops, regeneration, custom UI, and honest verification.
> Reach for it before writing any application code.

## How to make changes — use the MCP tools

\`.mcp.json\` registers a stdio MCP server that your client starts on its own, so
the \`mcp__maxstack__*\` tools are available in **every session**. Nothing needs
to be running first.

- \`query_spec\` — read the spec. **Start here.** \`query_spec {section:"ops"}\`
  lists every available spec-op; add \`ops:["page.addPage", …]\` to get the arg
  schemas for the handful you are about to use (all of them at once is a payload
  hosts refuse). The vocabulary is self-describing, so you never have to guess.
- \`propose_spec_change\` — dry-run an op and see the diff before landing it.
- \`apply_spec_change\` — validate + land the op.
- \`run_generator\` — regenerate \`${config.appDir}/\` from the spec.
- \`run_checks\` — the validate gate (spec referential integrity).
- \`explain_feature\` · \`list_acceptance_criteria\` · \`record_decision\`.

Every one of these is a spec-file operation — none needs a database or a web
server. The equivalent CLI verbs (\`${bin} add-entity\` · \`add-field\` ·
\`add-page\` · \`op\` · \`gen\` · \`validate\`) go through the same validated ops and
are fine to use, particularly the terminal sugar; prefer the tools when you want
the diff first.

## Field types

The canonical types are exactly six:

| type | notes |
| --- | --- |
| \`string\` | |
| \`number\` | |
| \`boolean\` | |
| \`date\` | |
| \`enum\` | carries an option list |
| \`json\` | avoid \`z.array\` shapes in generated forms |

Raw ops (\`apply_spec_change\`) accept **only** those. The CLI \`--field\` DSL also
accepts aliases that it folds into them — \`text\`/\`str\`→\`string\`,
\`int\`/\`float\`/\`num\`→\`number\`, \`bool\`→\`boolean\`, \`datetime\`→\`date\`. \`text\` is
sugar, not a type: sending it through a raw op is rejected.

DSL shape: \`name:type\`, \`!\` suffix for required, \`enum(a,b,c)\` for options,
\`ref:e-other\` (or \`->e-other\`) for a reference. So

\`\`\`sh
${bin} add-entity bottle --field title:text! \\
  --field 'status:enum(todo,done)' --field owner:ref:e-user
\`\`\`

**Quote any spec carrying \`(\` or \`->\`.** Both are shell syntax: unquoted
\`owner:->e-user\` is the word \`owner:-\` plus a redirect that writes an empty
file named \`e-user\`, and the CLI then complains about a field type \`-\` you
never typed. \`ref:e-other\` needs no quoting, which is why it leads here.

## Owning a route

Generated files under \`${config.appDir}/\` are overwritten on every regeneration.
**Never hand-edit them** — a \`.claude/settings.json\` hook enforces this and will
refuse the write, so reach for the spec first rather than trying to get an edit
past it. To take a route over:

\`\`\`sh
${bin} eject <route-id>        # --dry-run to preview
\`\`\`

After that the file is yours and regeneration leaves it alone — but so does
every future spec change, which you then have to mirror by hand. Reach for it
when the spec genuinely cannot express what you need, not on first sight of a
plain generated page.

**Try a slot first.** Add a \`slot:<name>\` block to the page and fill
\`${config.appDir}/routes/<resource>.slots.tsx\` — it's yours, it survives
regeneration, and the edit hook allows it. Declare the block with
\`"mode": "replace"\` and it renders *instead of* the default table rather than
below it, which is what a redesign usually wants. The page stays spec-driven.

What an owned route gets, so you don't have to go read the runtime to find out:

- It renders **inside the project frame** and is handed **no props**.
- It therefore **fetches its own data client-side**, after hydration.
- The REST surface is \`/api/<resource>\`: \`GET\` (list), \`POST\` (create),
  \`PATCH /api/<resource>/<id>\`, \`DELETE /api/<resource>/<id>\`. Field names on
  the wire are camelCase.
- Ownership is tracked in a manifest — eject through the CLI, never by editing
  the file's generated header.

**Owned code does not run under a plain \`${bin} dev\`**, which serves a
prebuilt runtime. Use \`${bin} dev --owned\` (live, needs pnpm) or
\`${bin} build\` (image). Restart the one server you have rather than starting a
second one — two servers over one project share a single-writer data dir and
will silently disagree about your rows.

## Verifying a change

Don't call a change done on a green gate alone — drive the running app and
observe the behavior. \`run_checks\` / \`${bin} validate\` prove the spec and
manifest invariants; \`${bin} dev\` (visit \`/admin\` · \`/workbench\`) shows the
change actually working.

## When the app misbehaves: spec bug or runtime bug?

Run \`${bin} doctor\` first — it reports the CLI/runtime versions, staleness,
the store lock, the dev-server record and whether the MCP server answers.

Then place the bug on the right side of the line, because only one side is in
this repository:

- **The spec decides what exists** — entities, fields, pages, blocks, which
  fields a list shows, the theme. Wrong/missing content is a spec question, and
  a spec-op fixes it. That is your job here.
- **The runtime decides how it behaves** — rendering, form widgets and their
  coercion, routing, hydration, auth, \`/api/<resource>\`, the admin/workbench
  shells. It is the prebuilt \`maxstack-runtime\` package, identical for every
  maxstack project, and **nothing in this project can change it**.

So: a date field that stores the wrong day, a dismissed banner that comes back,
a form that posts the wrong shape — those are **runtime bugs**. Do not audit the
spec for them, do not eject a route to work around one, and do not hand-write an
app to escape it. Say plainly that it looks like a runtime bug and point the user
at https://github.com/sys13/maxstack/issues (with \`${bin} doctor\` output).
Contributors can debug one directly with
\`${bin} runtime link <path-to-a-maxstack-checkout>\`.
`
}
