/**
 * `maxstack mcp` — the MCP server over **stdio**, for a project on disk.
 *
 * Why this exists: `.mcp.json` used to register an *HTTP* server at a pinned
 * port, which only answered while `maxstack dev` was running. Agent clients
 * connect at session start, so a session opened before `dev` came up saw no
 * tools at all, and the docs had to hedge every MCP instruction with a
 * cold-start fallback. A stdio server is spawned by the client
 * itself, so `mcp__maxstack__*` is present in **every** session, unconditionally
 * — no port, no ordering, no second shell.
 *
 * Every platform tool is a pure spec-file operation, so none of them needs a web
 * server or an open database — that is what lets this host answer at session
 * start with nothing else running. This used to enumerate them ("all eight"),
 * which was six tools stale by the time anybody read it; `PLATFORM_TOOL_NAMES`
 * is the list, and `docs/mcp-reference.md` is generated from it. The
 * per-resource Sprout CRUD tools DO need a database, and are deliberately absent
 * here — {@link handleMcpRequest} reports that clearly if one is called.
 *
 * Spec writes land through the same atomic tmp+rename the web host uses, and
 * `maxstack dev` watches the spec *directory*, so a running dev server
 * regenerates from changes made here exactly as it does for HTTP-driven ones.
 *
 * **stdout carries the protocol and nothing else.** Anything that would
 * otherwise `console.log` (the legacy-spec migration notice, say) is redirected
 * to stderr for the life of the process; a stray line on stdout corrupts the
 * stream and kills the client handshake.
 */

import { createInterface } from 'node:readline'
import { describeCatalog, previewInstall } from '@maxstack/features/bundle'
import {
	type CheckRunner,
	createGeneratorRegistry,
	docsGenerator,
	e2eTestsGenerator,
	type GeneratorResult,
	handleMcpRequest,
	type JsonRpcRequest,
	type PlatformContext,
	type RegisteredGenerator,
	typesGenerator,
} from '@maxstack/mcp'
import { recordDefect } from '../lib/defects.ts'
import {
	generateProject,
	projectDrift,
	projectGenerationWatermark,
} from '../lib/generate.ts'
import { loadProject, type Project } from '../lib/project.ts'
import { projectCheckRunner } from '../lib/project-checks.ts'
import { projectReviewCost } from '../lib/review-cost.ts'
import { ownershipRiskContext } from '../lib/review-risk.ts'

/**
 * The `page` generator, disk-backed.
 *
 * The built-in emits into an in-memory FS and returns the files as data for
 * review — right for the web host, wrong here: with no dev server running,
 * nothing else would ever land them, and an agent that called `run_generator`
 * would be told it succeeded while `app/` stayed empty. This runs the CLI's own
 * `generateProject` (the same never-clobber writer `maxstack gen` uses) so the
 * tool means on stdio what its name promises.
 */
export function diskPageGenerator(project: Project): RegisteredGenerator {
	return {
		name: 'page',
		summary:
			'Emit route/slot/manifest code for the spec pages, landing them in app/ (never-clobber).',
		async run(): Promise<GeneratorResult> {
			const { writes, artifacts } = await generateProject(project)
			return {
				generator: 'page',
				// Files are on disk; report what happened rather than echoing content.
				artifacts: [],
				notes: [
					...writes.map((w) => `${w.action}: ${w.file}`),
					...artifacts.map((a) => `wrote: ${a}`),
				],
			}
		},
	}
}

/**
 * The `e2e-tests` generator, disk-backed.
 *
 * Same reason `page` is wrapped: the built-in returns the spec files as data,
 * which is right for the web host and useless on stdio, where nothing else will
 * ever land them. An agent told "scaffolded 3 e2e spec files" while `e2e/` stays
 * empty learns that the declared-tests route does not work, and goes back to
 * driving a browser by hand — which is the whole failure this closes.
 *
 * Never-clobber, like every other writer here: a spec file that already exists
 * has bodies somebody wrote, and regenerating over it would delete the only
 * thing in the chain that is not derivable.
 */
export function diskE2eGenerator(project: Project): RegisteredGenerator {
	return {
		name: 'e2e-tests',
		summary:
			'Scaffold a Playwright spec per page.e2eTests sentence into e2e/ (never-clobber; fill the bodies in).',
		async run(spec): Promise<GeneratorResult> {
			const { mkdir, writeFile } = await import('node:fs/promises')
			const { dirname, resolve } = await import('node:path')
			const { access } = await import('node:fs/promises')
			const built = await e2eTestsGenerator.run(spec, {})
			const notes: string[] = []
			for (const artifact of built.artifacts) {
				// `project.appPath`, not the project root — the same place
				// `maxstack gen` writes them. Two writers landing the same file in
				// two places is how a project ends up with two copies of a test and
				// no idea which one runs.
				const path = resolve(project.appPath, artifact.path)
				try {
					await access(path)
					notes.push(`skipped-user-owned: ${artifact.path}`)
					continue
				} catch {
					// Not there yet — ours to write.
				}
				await mkdir(dirname(path), { recursive: true })
				await writeFile(path, artifact.content, 'utf8')
				notes.push(`wrote: ${artifact.path}`)
			}
			return {
				generator: 'e2e-tests',
				artifacts: [],
				notes: notes.length ? notes : built.notes,
			}
		},
	}
}

/**
 * The `types` generator, disk-backed.
 *
 * Wrapped for the same reason as `page` and `e2e-tests`: on stdio nothing else
 * lands the file, and generated types the project never sees are types nothing
 * compiles. Always overwritten — every line is derived, and a stale copy is a
 * union that has quietly stopped matching the spec.
 */
export function diskTypesGenerator(project: Project): RegisteredGenerator {
	return {
		name: 'types',
		summary: typesGenerator.summary,
		async run(spec): Promise<GeneratorResult> {
			const { mkdir, writeFile } = await import('node:fs/promises')
			const { dirname, resolve } = await import('node:path')
			const built = await typesGenerator.run(spec, {})
			const notes: string[] = []
			for (const artifact of built.artifacts) {
				const path = resolve(project.appPath, artifact.path)
				await mkdir(dirname(path), { recursive: true })
				await writeFile(path, artifact.content, 'utf8')
				notes.push(`wrote: ${artifact.path}`)
			}
			return {
				generator: 'types',
				artifacts: [],
				notes: [...notes, ...built.notes],
			}
		},
	}
}

function platformContext(
	project: Project,
	checks: CheckRunner,
): PlatformContext {
	return {
		spec: project.spec,
		generators: createGeneratorRegistry([
			diskPageGenerator(project),
			docsGenerator,
			diskE2eGenerator(project),
			diskTypesGenerator(project),
		]),
		// The project's REAL gate, not just the spec-only built-in.
		// Whatever the project cannot run is reported as unavailable rather than
		// omitted, so `ok: true` can never mean "one check passed and nothing
		// looked at your code".
		checks,
		origin: 'ai',
		now: () => new Date().toISOString().slice(0, 10) as never,
		nextOpId: () => `op-${crypto.randomUUID()}` as never,
		// Catalog discovery + install preview. Wired by the host
		// because `@maxstack/mcp` deliberately does not depend on the feature
		// catalog — see `PlatformContext.catalog`. Both surfaces read the same
		// derivation the CLI's `maxstack add` prints, so an agent and a human
		// browsing the catalog cannot be told different things.
		catalog: {
			list: () => describeCatalog(project.config.bundles),
			preview: async (slugs) =>
				previewInstall(
					await project.spec.load(),
					slugs,
					project.config.bundles.map((b) => b.slug),
				),
		},
		// The ownership drift report. Same host-wiring reason as
		// `catalog`: drift is a disk fact, and `@maxstack/mcp` has only a spec
		// store. The agent and `maxstack drift` read the same derivation, so they
		// cannot report different things about the same file.
		ownership: {
			drift: async () => projectDrift(project, await project.spec.load()),
			// The same ownership facts `maxstack review` and the workbench pane read,
			// through the same derivation. Three surfaces agreeing about
			// which proposals are batchable is not a nicety: the first version of this
			// had only the web host reading the manifest, and the two surfaces gave
			// different answers about the same five proposals — which makes the risk
			// classification worthless, because a reviewer just uses whichever one
			// says yes.
			riskContext: async () => {
				const spec = await project.spec.load()
				return ownershipRiskContext(project, spec)
			},
		},
		// Review cost, on the same host-wiring terms: it is derived
		// from an event log in the data dir and gated on the project's opt-in.
		// `null` when the project did not opt in, so the agent sees an absent
		// measurement rather than a zero it would read as "review is free".
		reviewCost: {
			report: () => projectReviewCost(project),
		},
		// How far the built app is behind the spec, for the `warnings`/`next` pair
		// every tool result carries. Wired here because it is a disk fact (the
		// route manifest's watermark) — the same one `maxstack drift` reads, so an
		// agent and the CLI cannot disagree about whether the app is current.
		generation: {
			watermark: () => projectGenerationWatermark(project),
		},
		// Somewhere for a defect to go. Without one, an agent that
		// hits a framework bug files it into whatever write-shaped tool is in
		// reach — which is how a bug became a resolved entry in the append-only
		// decision ledger.
		defects: {
			record: (report) => recordDefect(project.root, report),
		},
	}
}

export async function mcpCommand(dir: string): Promise<void> {
	// stdout is the wire from here on — every incidental log goes to stderr.
	console.log = (...args: unknown[]) => console.error(...args)

	const project = await loadProject(dir)
	const ctx = {
		platform: platformContext(project, await projectCheckRunner(project)),
	}

	console.error(`· maxstack mcp (stdio) — ${project.root}`)

	const rl = createInterface({ input: process.stdin })
	for await (const line of rl) {
		const text = line.trim()
		if (!text) continue

		let body: JsonRpcRequest
		try {
			body = JSON.parse(text) as JsonRpcRequest
		} catch (e) {
			const message = e instanceof Error ? e.message : 'Invalid JSON'
			write({
				jsonrpc: '2.0',
				id: null,
				error: { code: -32700, message: `Parse error: ${message}` },
			})
			continue
		}

		// 202 is the notification case — accepted, deliberately unanswered. On
		// stdio "no response" means writing nothing at all; emitting an empty
		// object would be an unsolicited message the client can't match to an id.
		const { status, body: rpc } = await handleMcpRequest(ctx, body)
		if (status !== 202) write(rpc)
	}
}

function write(body: Record<string, unknown>): void {
	process.stdout.write(`${JSON.stringify(body)}\n`)
}
