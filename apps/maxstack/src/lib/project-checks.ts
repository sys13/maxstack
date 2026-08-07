/**
 * The check registry for a project on disk.
 *
 * `run_checks` used to answer `{ok: true}` after running exactly one check —
 * `spec-validate`, which reads the spec and never opens a single file the
 * maintainer owns. The CLI host registered nothing else, so typecheck, lint and
 * test were not failing: they were **absent**, and absent is indistinguishable
 * from passing in a payload that only reports what it ran. An agent takes
 * `ok: true` as terminal, which is exactly why a whole session can go by without
 * a typecheck ever executing over the code it just wrote.
 *
 * So this module does two things, and the second matters as much as the first:
 *
 *  1. Registers the project's own `typecheck` / `lint` / `test` commands as real
 *     checks, so `run_checks` and `maxstack validate` drive the actual gate —
 * plus `e2e` once the spec declares any e2e tests, so the
 *     declare -> generate -> run chain has a runner at the end of it.
 *  2. Names every one of them the project does NOT define as **unavailable**,
 *     with the reason and the remedy — never silently omitted. A scaffold with
 *     no `typecheck` script must report "typecheck never ran", not a green.
 *
 * The commands are discovered from `package.json` `scripts` rather than assumed.
 * A project that spells its typecheck `tsc --noEmit` under a different script
 * name has not lost the check; it has an unavailable one that says exactly which
 * script name would make it run.
 */

import { resolve } from 'node:path'
import { MANIFEST_FILENAME, parseManifest } from '@maxstack/core/ownership'
import {
	createCheckRegistry,
	type CheckRunner,
	shellCheck,
	specValidateCheck,
	type UnavailableCheck,
} from '@maxstack/mcp'
import type { Project } from './project.ts'

/**
 * The gate a maxstack project is expected to be able to run over owned code.
 *
 * `command` is not decoration: it is the remedy the report prints, so it has to
 * be a command that actually runs. The remedy used to fall back to the script
 * name (`"lint": "lint"`), which is not a binary — an agent following it
 * literally produced a package.json that failed differently, and a check that
 * errors is worse than one that is missing.
 */
interface ExpectedCheck {
	script: string
	summary: string
	why: string
	/** A real command that implements this script. */
	command: string
	/** The package that provides that command, for the same reason. */
	install: string
	/**
	 * Something the *machine* has to be true for a declared script to examine
	 * anything — not something about the code, which is what the check itself is
	 * for. A `null` answer means "go ahead and run it"; anything else is reported
	 * as UNEXAMINED with that reason and remedy, because a declared script that
	 * runs and looks at nothing is the hollow green this whole module refuses.
	 */
	precondition?: (
		project: Project,
	) => Promise<{ reason: string; remedy: string } | null>
}

const EXPECTED: ExpectedCheck[] = [
	{
		script: 'typecheck',
		summary: 'TypeScript over the whole project, owned code included.',
		why: 'nothing type-checks the code you own, so a wrong hook shape or a bad payload ships silently',
		command: 'tsc --noEmit',
		install: 'typescript',
	},
	{
		script: 'lint',
		summary: 'The project’s linter.',
		why: 'nothing lints the code you own',
		command: 'biome check .',
		install: '@biomejs/biome',
	},
	{
		script: 'test',
		summary: 'The project’s test suite.',
		why: 'nothing runs the code you own',
		command: 'vitest run',
		install: 'vitest',
		precondition: async (project) =>
			(await hasUnitTests(project))
				? null
				: {
						reason:
							'"test" is declared but this project has no test files, so nothing runs the code you own',
						remedy:
							'Write a test next to the code it covers — `app/**/*.test.ts` (`.spec.ts` belongs to the e2e suite) — and run it again.',
					},
	},
]

/** The `scripts` block of the project's package.json, or `null` if there is none. */
async function projectScripts(
	root: string,
): Promise<Record<string, string> | null> {
	const { readFile } = await import('node:fs/promises')
	try {
		const raw = await readFile(resolve(root, 'package.json'), 'utf8')
		const parsed = JSON.parse(raw) as { scripts?: Record<string, string> }
		return parsed.scripts ?? {}
	} catch (err) {
		if ((err as NodeJS.ErrnoException).code === 'ENOENT') return null
		throw err
	}
}

/**
 * Does any accepted page declare an e2e test? Read from the spec rather than
 * from the presence of `e2e/` on disk: the declaration is the commitment, and a
 * project whose scaffolded specs were deleted still owes a way to run them.
 */
async function declaresE2eTests(project: Project): Promise<boolean> {
	try {
		const spec = await project.spec.load()
		return spec.pages.pages.some((p) => (p.e2eTests?.length ?? 0) > 0)
	} catch {
		// A project whose spec will not load has bigger problems, and
		// `spec-validate` is the check that reports them.
		return false
	}
}

/**
 * Does this project have a single file the `test` script could run?
 *
 * `vitest run --passWithNoTests` — what the scaffold declares — exits 0 over an
 * empty suite, which is the right behaviour for a runner and the wrong answer
 * for a gate. Without this, a fresh project's report reads `test ✔` having
 * opened nothing, which is exactly the shape #260 exists to refuse: a check that
 * did not examine anything must say so, not borrow the colour of one that did.
 *
 * Matched against the scaffolded `vitest.config.ts`'s own `include`, so the two
 * cannot disagree about what counts — `.test.ts` is vitest's, `.spec.ts` is
 * Playwright's and belongs to the `e2e` check below.
 */
async function hasUnitTests(project: Project): Promise<boolean> {
	const { readdir } = await import('node:fs/promises')
	try {
		const entries = await readdir(project.appPath, {
			recursive: true,
			withFileTypes: true,
		})
		return entries.some(
			(e) => e.isFile() && /\.test\.tsx?$/.test(e.name),
		)
	} catch {
		// No app dir at all. `spec-validate` is the check that reports *that*, and
		// answering "there are tests" here would only trade one wrong report for
		// another — so say what is true: none were found.
		return false
	}
}

/**
 * Are Playwright's browsers on this machine?
 *
 * `playwright test` without them fails with a legible box telling you to run
 * `playwright install` — legible, but still a **red** gate, and red means "your
 * code is broken". Nothing about the code is broken; a one-time download that
 * `npm install` deliberately does not perform has not happened. That is the
 * definition of unexamined, so it is reported as unexamined, with the command
 * that fixes it — the same distinction this module already draws for a declared
 * script whose `node_modules` are missing.
 *
 * The location is Playwright's documented browser cache, which is where its own
 * installer puts them. `PLAYWRIGHT_BROWSERS_PATH=0` means "inside node_modules",
 * a layout we cannot cheaply probe — so that answers `true` and lets the run
 * speak for itself, rather than reporting UNEXAMINED at a project that is fine.
 */
async function hasPlaywrightBrowsers(): Promise<boolean> {
	const { readdir } = await import('node:fs/promises')
	const { homedir } = await import('node:os')
	const configured = process.env.PLAYWRIGHT_BROWSERS_PATH
	if (configured === '0') return true
	const dir =
		configured ||
		(process.platform === 'darwin'
			? resolve(homedir(), 'Library/Caches/ms-playwright')
			: process.platform === 'win32'
				? resolve(
						process.env.LOCALAPPDATA ?? homedir(),
						'ms-playwright',
					)
				: resolve(homedir(), '.cache/ms-playwright'))
	try {
		return (await readdir(dir)).some((e) => e.startsWith('chromium-'))
	} catch {
		return false
	}
}

/** Whether this project's dependencies have been installed at all. */
async function hasNodeModules(root: string): Promise<boolean> {
	const { access } = await import('node:fs/promises')
	try {
		await access(resolve(root, 'node_modules'))
		return true
	} catch {
		return false
	}
}

/**
 * Does this project own any code yet?
 *
 * "Owned" is the manifest's own word for it: a filled slot or an ejected route —
 * the files a regeneration will not touch, and therefore the only files these
 * checks exist to examine. A freshly scaffolded project has none, which is why
 * it must not be told that three checks left its code unexamined: there is no
 * such code, and no action the person running `maxstack init` could have taken
 * to make the gate green.
 *
 * A missing or unreadable manifest answers `true`. The failure this whole module
 * guards is a hollow green, so an unknown ownership state resolves to the strict
 * side — and it is only ever unknown outside the scaffold, which writes the
 * manifest before it prints its first line.
 */
async function ownsCode(project: Project): Promise<boolean> {
	const { readFile } = await import('node:fs/promises')
	try {
		const manifest = parseManifest(
			await readFile(resolve(project.appPath, MANIFEST_FILENAME), 'utf8'),
		)
		// `ownership !== 'generated'` — every file the generator has recorded as
		// not-its-own: an ejected route, a slot file, a seam handler stub. Matching
		// on `slotFile`/`ejected` alone (the way `doctor` counts) would miss the
		// seam handlers, which get a `user` entry of their own with no slotFile,
		// and missing an owned file here is exactly the hollow green.
		return manifest.entries.some(
			(e) => e.ownership !== 'generated' || Boolean(e.slotFile),
		)
	} catch {
		return true
	}
}

/**
 * The runner `maxstack validate` and the MCP `run_checks` tool both use — one
 * registry, so the CLI and an agent cannot be told different things about
 * whether this project's code was examined.
 */
export async function projectCheckRunner(
	project: Project,
): Promise<CheckRunner> {
	const scripts = await projectScripts(project.root)
	const checks = [specValidateCheck]
	const unavailable: UnavailableCheck[] = []

	// `e2e` is expected only once the spec declares tests. Demanding
	// it of a project that has declared none would be noise; withholding it from
	// one that HAS declared them is the gap that sends an agent back to driving a
	// browser by hand, because the chain it was told about dead-ends.
	const expected = [...EXPECTED]
	if (await declaresE2eTests(project))
		expected.push({
			script: 'e2e',
			summary: 'The declared end-to-end tests.',
			why: 'the pages declare e2eTests and nothing runs them',
			command: 'playwright test',
			install: '@playwright/test',
			precondition: async () =>
				(await hasPlaywrightBrowsers())
					? null
					: {
							reason:
								'"e2e" is declared but Playwright has no browsers on this machine, so the declared end-to-end tests did not run',
							remedy:
								'Run `npx playwright install chromium` (a one-time ~100MB download `npm install` does not do for you) and check again.',
						},
		})

	// A check that cannot run over code that does not exist yet is named, but does
	// not withhold the green — see `ownsCode`.
	const blocking = await ownsCode(project)

	if (scripts === null) {
		for (const { script, why, command } of expected)
			unavailable.push({
				name: script,
				blocking,
				reason: `this project has no package.json, so ${why}`,
				remedy: `Add a package.json with \`"${script}": "${command}"\` in its scripts block.`,
			})
		return createCheckRegistry(checks, unavailable)
	}

	// A declared script whose toolchain was never installed cannot run, and the
	// difference matters: "npm run typecheck" in a project with no node_modules
	// exits non-zero for a reason that has nothing to do with the code. Reporting
	// that as a FAILING typecheck would be as misleading in the other direction —
	// so it is reported as unexamined, which is what it is.
	const installed = await hasNodeModules(project.root)

	for (const {
		script,
		summary,
		why,
		command,
		install,
		precondition,
	} of expected) {
		// Ordered strictly: no package.json beats no install beats an unmet
		// precondition. Each reason is only worth printing once the one above it
		// holds — "no test files" is noise at a project that has not installed
		// vitest yet, and following it would not make the check run.
		const unmet =
			scripts[script] && installed && precondition
				? await precondition(project)
				: null
		if (scripts[script] && !installed) {
			unavailable.push({
				name: script,
				blocking,
				reason: `"${script}" is declared but this project's dependencies are not installed, so ${why}`,
				remedy: 'Run `npm install` (or `pnpm install`) and check again.',
			})
		} else if (unmet) {
			unavailable.push({ name: script, blocking, ...unmet })
		} else if (scripts[script]) {
			checks.push(
				shellCheck(script, summary, `npm run --silent ${script}`, {
					cwd: project.root,
				}),
			)
		} else {
			unavailable.push({
				name: script,
				blocking,
				reason: `package.json declares no "${script}" script, so ${why}`,
				remedy: `Add \`"${script}": "${command}"\` to the scripts block (\`npm i -D ${install}\`) and run it again.`,
			})
		}
	}
	return createCheckRegistry(checks, unavailable)
}
