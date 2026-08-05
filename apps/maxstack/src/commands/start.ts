/**
 * `maxstack start "<description>"` — one command from a sentence to a
 * populated, clickable app.
 *
 * The quickstart used to tell a first-time reader, in the middle of step two,
 * *"it starts empty, so there's nothing to see yet."* That sentence competes
 * against a rival whose whole product is "type a sentence, watch an app
 * appear". This is the answer: scaffold, land the spec-ops the description
 * implies, seed representative rows, start the server, print where to click.
 *
 * What it deliberately is **not**:
 *
 *   - **Not a second `init`.** It calls {@link scaffoldProject}, the exact
 *     writer `init` uses. A divergent scaffold would be a second product.
 *   - **Not a second op path.** The blueprint compiles through `buildEntity` /
 *     `buildPage` and lands via `landOps`, so the starting spec is reviewable
 *     the same way every later change is — the ops are in the op log with
 *     `origin: "ai"` and suggested provenance, not conjured grounding truth.
 *   - **Not a second seeder.** Seeding POSTs the dev server's own
 * `/onboarding/seed`, the same route the wizard's button hits,
 *     so the rows are committed and visible before success is claimed.
 *   - **Not magic that hides its work.** It prints the ops it landed and the
 *     command that removes the demo rows, because the user's first experience
 *     of provenance should be the thing that just happened to them.
 *
 * Failure is recoverable in place: the scaffold either refuses up front
 * (preflight's already-a-project finding) or completes, and every phase after
 * it names the command that continues from where it stopped. A half-scaffolded
 * project you cannot re-run is worse than an error before anything was written.
 */

import { resolve } from 'node:path'
import {
	type AppBlueprint,
	type BlueprintSource,
	describeApp,
	isMockAi,
	projectSlug,
	selectAiClient,
} from '@maxstack/spec-derive'
import { blueprintToOps } from '../lib/blueprint.ts'
import { gitBootstrapNotice } from '../lib/git.ts'
import { landOps } from '../lib/land.ts'
import { loadProject } from '../lib/project.ts'
import { devCommand, seedWhenReady } from './dev.ts'
import { scaffoldProject } from './init.ts'

export interface StartOptions {
	/** Port the dev server should serve on (default `PORT` env, then 3000). */
	port?: string
	/** Store backend, passed through to the scaffold. */
	backend?: string
	/** `--no-seed`: scaffold and serve, but leave the app empty. */
	seed?: boolean
	/** `--no-dev`: stop after the app tree is generated (what CI gates). */
	dev?: boolean
}

/**
 * Does an AI client exist for the blueprint step? With neither a key nor
 * `MOCK_AI`, `selectAiClient` returns a client that refuses on first use — and
 * `describeApp` would dutifully catch that and report a "fallback reason" that
 * is really just "you have no API key". Checking here keeps the keyless path
 * honestly labelled as the deterministic compiler it is.
 */
function aiForBlueprint(env = process.env) {
	if (isMockAi(env) || env.ANTHROPIC_API_KEY || env.OPENAI_API_KEY) {
		return selectAiClient(env)
	}
	return undefined
}

export async function startCommand(
	description: string,
	dir: string | undefined,
	opts: StartOptions = {},
): Promise<void> {
	const desc = description.trim()
	if (!desc) {
		throw new Error(
			'start needs a description — e.g. maxstack start "a bug tracker for small teams"',
		)
	}

	// 1. The description → a starting blueprint. Nothing is written yet, so a
	//    model failure here costs nothing: `describeApp` falls back to the
	//    deterministic compiler rather than aborting the command.
	const described = await describeApp({
		description: desc,
		ai: aiForBlueprint(),
	})
	const blueprint = described.blueprint
	const target = dir ?? projectSlug(blueprint.title)

	console.log(`\n  ${bold(blueprint.title)}  ${dim(`${DASH} ${desc}`)}`)
	console.log(`  ${dim(blueprintLine(blueprint, described.source))}`)
	if (described.fallbackReason) {
		console.log(
			`  ${dim(`(the model's answer was unusable — ${described.fallbackReason})`)}`,
		)
	}

	// 2. The scaffold — byte-identical to `maxstack init`.
	const { root, invocation, git } = await scaffoldProject({
		root: resolve(target),
		name: blueprint.title,
		desc,
		backend: opts.backend,
	})
	console.log(`\n  ${green(CHECK)} scaffolded  ${dim(root)}`)
	// Same rule as `init`: if the never-clobber guarantee has no
	// undo behind it, say so before anything is written into the project.
	const gitNotice = gitBootstrapNotice(git)
	if (gitNotice) console.warn(`  ! ${gitNotice}`)

	// 3. The starting spec, as reviewable ops. Landed with `origin: 'ai'` so the
	//    op log records who wrote them; the field DSL stamps the rows suggested,
	//    which is what makes them visible as machine-authored in the review
	//    surfaces rather than indistinguishable from the user's own edits.
	const project = await loadProject(root)
	const { ops, routes } = blueprintToOps(blueprint, 'ai')
	const landed = await landOps(project, ops, {
		gen: true,
		origin: 'ai',
		// `start` writes the blueprint the AI drafted, so the actor is the command
		// itself rather than the environment's — an agent shelling out to `start`
		// and a person running it produce the same machine-authored spec.
		actor: { surface: 'cli', path: 'cli-start', agent: 'maxstack-start' },
	})
	console.log(
		`  ${green(CHECK)} landed ${ops.length} spec-op${ops.length === 1 ? '' : 's'}  ` +
			`${dim(`${DASH} origin: ai, in the op log`)}`,
	)
	for (const entity of blueprint.entities) {
		console.log(
			`     ${dim(BRANCH)} ${entity.name.padEnd(nameWidth(blueprint))}  ` +
				`${dim(entity.fields.join(' · '))}`,
		)
	}
	console.log(
		`  ${green(CHECK)} generated ${landed.gen?.writes.length ?? 0} route writes  ` +
			`${dim(`${DASH} ${landed.gen?.artifacts.length ?? 0} artifacts`)}`,
	)

	// `--no-dev` is the CI shape and the "just scaffold it" shape: everything
	// that touches disk has happened, so stop here and say what continues it.
	if (opts.dev === false) {
		console.log(`\n  ${bold('next')}\n`)
		console.log(
			steps([
				[`cd ${target}`, ''],
				[`${invocation.shell} dev`, 'serve the app'],
				[`${invocation.shell} demo`, 'load sample rows'],
			]),
		)
		console.log()
		return
	}

	// 4. Seed + serve. The seed runs *through* the server we are about to start
	// (a second process opening the same pglite store seeds into a
	//    private view the server never sees), so it is scheduled here and fires
	//    when the port answers. `dev` then holds the foreground, as it always does.
	const port = opts.port ?? process.env.PORT ?? '3000'
	const seeding =
		opts.seed === false
			? null
			: seedWhenReady(port, {
					onFail: (why) =>
						console.log(
							`  ${dim(`· could not seed automatically (${why}) ${DASH} run \`${invocation.shell} demo\``)}`,
						),
				})

	console.log(`\n  ${bold('your app')}\n`)
	console.log(
		steps([
			[`http://localhost:${port}${routes[0]?.route ?? ''}`, 'the app'],
			[`http://localhost:${port}/workbench`, 'review what was just written'],
		]),
	)
	console.log(
		`\n  ${dim(`sample rows are demo data ${DASH} remove them with`)} ${cyan(`${invocation.shell} demo --clear`)}\n`,
	)

	try {
		await devCommand(root, { port })
	} finally {
		seeding?.cancel()
	}
}

/** `2 entities · 9 fields · written by the deterministic compiler`. */
function blueprintLine(
	blueprint: AppBlueprint,
	source: BlueprintSource,
): string {
	const fields = blueprint.entities.reduce((n, e) => n + e.fields.length, 0)
	const how =
		source === 'ai'
			? 'drafted by the model'
			: 'from the deterministic compiler (no API key)'
	return `${count(blueprint.entities.length, 'entity', 'entities')} ${MID} ${count(fields, 'field')} ${MID} ${how}`
}

function nameWidth(blueprint: AppBlueprint): number {
	return Math.max(...blueprint.entities.map((e) => e.name.length))
}

function count(n: number, noun: string, plural = `${noun}s`): string {
	return `${n} ${n === 1 ? noun : plural}`
}

// --- terminal styling (mirrors init.ts; kept local for the same reason) -----

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
const CHECK = isUtf8() ? '✔' : 'ok'
const DASH = isUtf8() ? '—' : '--'
const MID = isUtf8() ? '·' : '-'
const BRANCH = isUtf8() ? '├' : '|'

function steps(rows: [cmd: string, note: string][]): string {
	const withNotes = rows.filter(([, n]) => n)
	const width = withNotes.length
		? Math.max(...withNotes.map(([c]) => c.length))
		: 0
	return rows
		.map(([cmd, note]) =>
			note
				? `    ${cyan(cmd.padEnd(width))}  ${dim(`# ${note}`)}`
				: `    ${cyan(cmd)}`,
		)
		.join('\n')
}
