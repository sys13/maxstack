/**
 * **The bespoke-live-UI extension point** — the generated half.
 *
 * A declared live channel (`live.declare`) says which entity a subscriber
 * follows, what a change notification carries, which rows are in the bound, and
 * how much load the channel may put on the process. For most surfaces that is
 * the *whole thing*, and this module emits **nothing at all**: a derived list, a
 * board, a calendar or a timeline over an entity with a `query` channel simply
 * updates, and the declaration is the implementation.
 *
 * That is the honest half of the win and it is worth stating plainly rather than
 * quietly, because the temptation in a feature like this is to emit a component
 * per channel so the generator looks busy. A project whose live surfaces are all
 * ordinary derived views grows no code.
 *
 * What a declaration cannot say is what a *bespoke* live surface looks like.
 * taskly's ask is a drag-and-drop board where cards move under you while other
 * people are looking at the same one; bookclub's is a threaded reader that
 * appends posts in place. Neither is a table with a subscription attached, and
 * the two ways to handle that are both bad if taken alone: teach the page layer
 * about drag targets and thread nesting (and then about the next product's
 * variation on it, forever — the framework-as-cage failure), or leave the
 * maintainer to eject the whole surface and re-implement the gate, the
 * projection, the bound and the reconnection along with the layout.
 *
 * So the platform generates the seam and the user fills it, exactly as it does
 * for a schedule handler, a source refiner and an import parser:
 *
 *   - `live/live.generated.ts` — **framework-owned**. A registry mapping every
 *     channel that declared `slot: true` to its component. Re-emitted on every
 *     regeneration; nobody edits it.
 *   - `live/<key>.live.tsx` — **user-owned, written once**. Receives rows that
 *     are already loaded, gated and projected, plus the presence list.
 *     Regeneration never touches it again.
 *
 * **The slot stops at rendering, and that is what keeps it from being a bypass.**
 * It is handed rows and identities; it has no store, no registry, no user and no
 * channel object, so there is nothing it could read that the gate did not
 * already allow and nothing it could push that the projection did not already
 * narrow. That is the same argument #175 makes about a parser and #173 about a
 * refiner, one step further out: the bespoke code never reaches the read path at
 * all.
 *
 * That is what moves an ask like taskly's live board from *off-surface* (weight
 * 8: no op, no slot, no guidance) to *slot fill* (weight 3). The honesty of the
 * win is in what did **not** happen: the op vocabulary did not learn about drag
 * targets, cursors or thread nesting, and the platform still cannot draw a
 * collaborative board — it knows where the code that can goes, keeps that code's
 * data correct and bounded, and promises never to overwrite it.
 *
 * **Nothing here reads a clock, a socket or a random source.** The emitted tree
 * is a function of the declaration alone — see
 * `apps/maxstack/src/lib/live-determinism.test.ts`, which generates with the
 * network removed and asserts that a channel with a thousand live subscribers
 * and one that has never been opened produce identical files.
 */

import {
	MANIFEST_FILENAME,
	parseManifest,
	type RouteManifest,
	serializeManifest,
} from './manifest.ts'
import type { Fs, WriteResult } from './write.ts'
import { writeGenerated, writeUserFileOnce } from './write.ts'

/** What the generator needs to know about one declared live channel. */
export interface LiveDescriptor {
	/** The declared key, e.g. `task-board`. */
	key: string
	/** One line, rendered into the stub so the file explains itself. */
	description: string
	/** `query` or `presence` — rendered into the stub's header. */
	kind: string
	/** The resource whose rows arrive, for the stub's header. */
	resource: string
	/** The declared bound, as prose. Never a value — a bound is per-subscriber. */
	bound: string
	/** The columns a message carries, for the stub's props type. */
	fields: string[]
	/** Whether this channel asked for a slot. Only these emit files. */
	slot: boolean
}

/** A live key as a filesystem-safe module name (`task.board` → `task-board`). */
export function liveModuleName(key: string): string {
	return key.replace(/[^a-z0-9]+/gi, '-').replace(/^-|-$/g, '')
}

/** Where a channel's files live, relative to the project root. */
export function liveFilePaths(key: string): {
	componentFile: string
	registryFile: string
} {
	return {
		componentFile: `live/${liveModuleName(key)}.live.tsx`,
		registryFile: 'live/live.generated.ts',
	}
}

/**
 * The user-owned live-surface stub. Written once and never again.
 *
 * The header states the four things a maintainer would otherwise learn the hard
 * way, and the last one is the important one:
 *
 *  1. The rows are already gated and projected — this is not where filtering
 *     goes, and putting it here would be a second, weaker copy of a rule the
 *     ops already enforce.
 *  2. The component re-renders when a message arrives, and receives a *removal*
 *     as an absent row rather than as an event, so there is no branch to forget.
 *  3. Presence is identities and nothing else; a maintainer looking for a place
 *     to put a cursor position will not find one, and finding out here is
 *     cheaper than the code review that catches it.
 *  4. **The connection may drop, and the surface must be correct when it does.**
 *     The platform falls back to polling the same op, so the props keep arriving
 *     — but they arrive slower, and a component that animates every delta will
 *     look broken. Render the state, not the transition.
 */
export function emitLiveComponentStub(descriptor: LiveDescriptor): string {
	const fields =
		descriptor.fields.length > 0
			? descriptor.fields.map((f) => `\t\t${f}?: unknown`).join('\n')
			: '\t\t// this channel declares no fields — see the presence note above'
	return [
		`/**`,
		` * Live surface for the "${descriptor.key}" channel — YOURS.`,
		` *`,
		` * ${descriptor.description}`,
		` *`,
		` * ${descriptor.kind} over "${descriptor.resource}", bounded to ${descriptor.bound}.`,
		` *`,
		` * This file is written once and never regenerated: edit it freely. The page`,
		` * frame, the navigation and the routing around it keep regenerating.`,
		` *`,
		` * **Your rows are already loaded, gated and projected.** They came out of`,
		` * the same read op every other surface uses, under the same access rules,`,
		` * the same tenant scope, the same soft-delete scope and the same declared`,
		` * bound — and carrying only the columns the channel declared. Do not filter`,
		` * here: a filter in a component is a second, weaker copy of a rule the ops`,
		` * already enforce, and it is the copy that gets skipped.`,
		` *`,
		` * **A removal arrives as an absent row, not as an event.** Render what you`,
		` * are given; there is no delta to apply and no branch to forget.`,
		` *`,
		` * **Presence is identities and nothing else** — no cursor, no selection, no`,
		` * "currently typing". That is a scope decision, not a gap: cursor-level`,
		` * co-editing is out by recorded decision (d-live-last-write-wins). If you`,
		` * need it, it is yours to build, and it does not belong on this channel.`,
		` *`,
		` * **The connection can drop.** The platform falls back to polling the same`,
		` * op, so these props keep arriving — just slower. Render the state, not the`,
		` * transition: a component that animates every delta looks broken the moment`,
		` * the deltas arrive five seconds apart.`,
		` */`,
		``,
		`export interface LiveProps {`,
		`\trows: {`,
		`\t\tid: string`,
		fields,
		`\t}[]`,
		`\t/** Who is here. An identity and a join time — there is nothing else on it. */`,
		`\tpresent: { identity: string; since: number }[]`,
		`\t/** True when more people are here than the channel reports by name. */`,
		`\ttruncated: boolean`,
		`\t/** True while the stream is down and rows are arriving by poll instead. */`,
		`\tpolling: boolean`,
		`}`,
		``,
		`export default function LiveSurface(props: LiveProps) {`,
		`\t// TODO: render the bespoke surface. \`props.rows\` is the current state.`,
		`\tvoid props`,
		`\treturn null`,
		`}`,
		``,
	].join('\n')
}

/** The framework-owned registry: declared key → live component module. */
export function emitLiveRegistry(
	descriptors: readonly LiveDescriptor[],
): string {
	const sorted = [...descriptors]
		.filter((d) => d.slot)
		.sort((a, b) => a.key.localeCompare(b.key))
	const imports = sorted.map(
		(d, i) => `import Live${i} from './${liveModuleName(d.key)}.live.tsx'`,
	)
	const entries = sorted.map((d, i) => `\t'${d.key}': Live${i},`)
	return [
		'// GENERATED by maxstack — do not edit.',
		'//',
		'// The declared live channels that asked for a bespoke surface, and the',
		'// component each one renders. Regenerated from `live.json` on every build;',
		'// the component modules it imports are yours and are never rewritten.',
		'//',
		'// Channels whose declaration was enough are absent here on purpose: a',
		'// derived list, board or calendar over them simply updates, and they need',
		'// no code at all.',
		'',
		"import type { ComponentType } from 'react'",
		...imports,
		'',
		'export const liveSurfaces: Record<string, ComponentType<never>> = {',
		...entries,
		'}',
		'',
	].join('\n')
}

export interface LiveGenerateResult {
	manifest: RouteManifest
	results: WriteResult[]
}

async function loadManifest(fs: Fs): Promise<RouteManifest> {
	if (await fs.exists(MANIFEST_FILENAME)) {
		return parseManifest(await fs.read(MANIFEST_FILENAME))
	}
	return { version: 1, entries: [] }
}

/**
 * Generate the bespoke-surface seam for every channel that asked for one.
 * Idempotent: the registry is rewritten only when its content changed, and each
 * stub is written once and never again.
 *
 * A project with no *slotted* channels emits **nothing** — not an empty
 * registry, and not a `live/` directory. The same absence rule the spec layer
 * uses, and here it carries the second meaning it does for sources and imports:
 * an empty tree is the platform saying the declarations were enough.
 *
 * Removing the last slotted channel is therefore `pruneSeams`' job, not this
 * function's: an early return writes nothing, so the stale registry would
 * survive every run (#355).
 */
export async function generateLive(
	fs: Fs,
	descriptors: readonly LiveDescriptor[],
): Promise<LiveGenerateResult> {
	let manifest = await loadManifest(fs)
	const results: WriteResult[] = []
	const slotted = descriptors.filter((d) => d.slot)
	if (slotted.length === 0) return { manifest, results }

	const registryFile = liveFilePaths('_').registryFile
	const registry = await writeGenerated(
		fs,
		manifest,
		{ id: 'live:registry', routePath: '', file: registryFile },
		emitLiveRegistry(slotted),
	)
	manifest = registry.manifest
	results.push(registry.result)

	for (const descriptor of slotted) {
		const { componentFile } = liveFilePaths(descriptor.key)
		const written = await writeUserFileOnce(
			fs,
			manifest,
			`live:${descriptor.key}`,
			componentFile,
			emitLiveComponentStub(descriptor),
		)
		manifest = written.manifest
		results.push(written.result)
	}

	await fs.write(MANIFEST_FILENAME, serializeManifest(manifest))
	return { manifest, results }
}
