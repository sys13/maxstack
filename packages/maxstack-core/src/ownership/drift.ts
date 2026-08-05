/**
 * **The ownership drift report** — what you own, what it was
 * derived from, and how far behind the current derivation it has drifted.
 *
 * ## Why this is not the same as never-clobber
 *
 * Never-clobber answers "will the platform touch my file?" — no, and
 * `regenerateAsDiff` already reports a protected file with an empty patch,
 * because there is nothing to propose. That is the right *write* behavior and it
 * is a lousy *reporting* behavior: it tells you the file is safe and says
 * nothing about the fact that the derivation it was copied from moved three
 * releases ago.
 *
 * The eject tax is real and it is deferred. You pay it the day a framework
 * improvement lands in every generated route except yours, and the honest
 * version of the promise is not "eject and forget" — it is **"eject, and we will
 * keep telling you what you're missing, without ever acting on it."** This
 * module is the second half.
 *
 * ## It is information, not a demand
 *
 * Drift reporting that nags is drift reporting people turn off, and a signal
 * nobody reads is worse than none — it *looks* like coverage. So:
 *
 *   - nothing here writes, proposes a write, or fails a gate. It computes;
 *   - drift is not an error state. An ejected file that has diverged is a file
 *     doing exactly what ejecting it was for. `status` says `drifted`, not
 *     `stale`, and the explanations are descriptive rather than imperative;
 *   - the surfaces that show it are pull, not push: `maxstack drift`, the
 *     `ownership_drift` MCP tool, the workbench pane. `gen` and `upgrade` print
 *     at most **one line** pointing at them.
 *
 * ## The "needs your attention" path
 *
 * When an upgrade genuinely needs to change something the user owns, the
 * platform must surface it as a reviewable diff with an explanation — never
 * apply it, and never silently skip it and leave the project broken. That is
 * this report, computed after the upgrade: the derivation moved, your copy did
 * not, and here is the patch between them. The file on disk is untouched either
 * way, which is why this can be honest about a breaking change instead of
 * choosing between clobbering and lying.
 */

import { createPatch } from 'diff'
import { BLOCK_SLOT_ROLES_VERSION } from './block-slots.ts'
import type { Ownership, RouteManifest } from './manifest.ts'
import type { RegenTarget } from './regen.ts'
import type { Fs } from './write.ts'

/**
 * Which seam an owned file came out of, read off its manifest id.
 *
 * The report needs this for one reason: `underived` is a status a maintainer is
 * meant to read as "nothing to compare", and until now it explained itself as
 * "the page this was generated for is no longer in the spec" — which is wrong
 * for a file that never came from a page, and reads like the platform lost track
 * of it. A schedule registry, a source refiner, an import parser and a bespoke
 * live surface are all seams the generator emits and a maintainer can own, and
 * each one is underived for its own reason.
 */
export type OwnedFamily =
	/** A resource page: `<resource>`, or its slot file `<resource>:slot`. */
	| 'page'
	/** `schedules:registry` or a `schedule:<key>:slot` handler. */
	| 'schedule'
	/** `sources:registry` or a `source:<key>:slot` refiner. */
	| 'source'
	/** `imports:registry` or an `import:<key>:slot` parser. */
	| 'import'
	/** `live:registry` or a `live:<key>:slot` bespoke surface. */
	| 'live'
	/** Owned, tracked, and from no seam this build knows about. */
	| 'other'

/**
 * The seam a manifest id belongs to. Keyed off the id prefixes the generators
 * write (`schedule:`/`schedules:`, …) rather than off the file path, because the
 * id is the thing the manifest is indexed by and the thing `eject` takes.
 */
export function ownedFamilyOf(id: string): OwnedFamily {
	if (id.startsWith('schedule:') || id.startsWith('schedules:'))
		return 'schedule'
	if (id.startsWith('source:') || id.startsWith('sources:')) return 'source'
	if (id.startsWith('import:') || id.startsWith('imports:')) return 'import'
	if (id.startsWith('live:')) return 'live'
	// A page is `<resource>` and its slot file is `<resource>:slot`. Anything
	// else with a namespace we do not recognise is `other` — better a vague
	// explanation than a confident wrong one.
	const suffix = id.includes(':') ? id.slice(id.indexOf(':') + 1) : ''
	return suffix === '' || suffix === 'slot' ? 'page' : 'other'
}

/** Why there is no current derivation, in the terms of the seam it came from. */
function underivedExplanation(family: OwnedFamily): string {
	const tail =
		'. The file is still yours and still runs — there is simply nothing to compare it to'
	switch (family) {
		case 'page':
			return `the page this was generated for is no longer in the spec${tail}`
		case 'schedule':
			return `no schedule declares this any more — either the declaration is gone or the file is a handler, which is written once and never derived again${tail}`
		case 'source':
			return `no source declares this any more — either the declaration is gone, it stopped asking for a refiner, or the file is a refiner, which is written once and never derived again${tail}`
		case 'import':
			return `no importer declares this any more — either the declaration is gone, its format stopped being custom, or the file is a parser, which is written once and never derived again${tail}`
		case 'live':
			return `no live channel declares this any more — either the declaration is gone, it stopped asking for a slot, or the file is a surface, which is written once and never derived again${tail}`
		case 'other':
			return `the platform derives nothing under this id${tail}`
	}
}

/** Where one owned file stands relative to what the generator would emit today. */
export type DriftStatus =
	/** Byte-identical to the current derivation — owned, but not yet diverged. */
	| 'in-sync'
	/** Diverged from the current derivation. Expected, and reported, not fixed. */
	| 'drifted'
	/**
	 * `user`-owned: authored by you, seeded once by the generator and never
	 * derived again. A filled slot file has **no** current derivation to be
	 * behind — it is supposed to differ from its stub — so diffing it against one
	 * would manufacture drift out of the feature working. Reported so the file is
	 * still listed as something you own.
	 */
	| 'authored'
	/**
	 * The platform can no longer derive a counterpart at all — the declaration it
	 * came from is gone, or the file is one of the write-once seams that is never
	 * derived twice. The file is still yours and still loads; there is simply
	 * nothing to compare it to. The explanation says which, per family.
	 */
	| 'underived'
	/** Tracked as owned, but not on disk. */
	| 'missing'

export interface OwnedFileDrift {
	id: string
	file: string
	ownership: Ownership
	status: DriftStatus
	/** The seam this file came out of — what makes the explanation accurate. */
	family: OwnedFamily
	/**
	 * Set on an `authored` file whose block-slot role vocabulary has moved since
	 * it was written: the props its slots are called with are a versioned public
	 * API, and this is the one thing that can change underneath a file the
	 * platform can never diff. Absent when the file records no version (authored
	 * before the stamp existed) or when it is current.
	 */
	rolesDrift?: { authored: number; current: number }
	/** Lines the current derivation has that the file does not. */
	behind: number
	/** Lines the file has that the current derivation does not — your work. */
	ahead: number
	/**
	 * Unified diff, **current derivation → your file**. Read `-` as "what the
	 * platform would emit today" and `+` as "what you have". Empty unless
	 * `status === 'drifted'`.
	 */
	patch: string
	/** One line a human can act on, or decide not to. */
	explanation: string
}

export interface OwnershipDriftReport {
	owned: OwnedFileDrift[]
	ownedCount: number
	driftedCount: number
	inSyncCount: number
	authoredCount: number
	underivedCount: number
	missingCount: number
	/** Authored files whose slot-role vocabulary moved out from under them. */
	rolesDriftCount: number
}

/** Count `+`/`-` body lines in a unified patch, ignoring the file headers. */
function countChangedLines(patch: string): { ahead: number; behind: number } {
	let ahead = 0
	let behind = 0
	for (const line of patch.split('\n')) {
		if (line.startsWith('+++') || line.startsWith('---')) continue
		if (line.startsWith('+')) ahead++
		else if (line.startsWith('-')) behind++
	}
	return { ahead, behind }
}

/**
 * Compare every file the manifest marks `ejected` or `user` against what the
 * generator would emit for it today.
 *
 * `targets` carries the current derivation per manifest id — the caller supplies
 * it because deriving means running the generators, which is the caller's
 * business (the CLI has the spec and the descriptors; a test has whatever it
 * built). An owned entry with no target is `underived`, not an error: pages get
 * deleted, and the file that was ejected from one is still the user's.
 *
 * Pure with respect to the filesystem: it only reads.
 */
export async function ownershipDrift(
	fs: Fs,
	manifest: RouteManifest,
	targets: readonly RegenTarget[],
): Promise<OwnershipDriftReport> {
	const byId = new Map(targets.map((t) => [t.id, t]))
	const owned: OwnedFileDrift[] = []

	for (const entry of manifest.entries) {
		if (entry.ownership === 'generated') continue
		const base = {
			id: entry.id,
			file: entry.file,
			ownership: entry.ownership,
			family: ownedFamilyOf(entry.id),
			behind: 0,
			ahead: 0,
			patch: '',
		}

		if (!(await fs.exists(entry.file))) {
			owned.push({
				...base,
				status: 'missing',
				explanation:
					'the manifest tracks this file as yours, but it is not on disk — ' +
					'nothing will regenerate it, because doing so is what ownership rules out',
			})
			continue
		}

		// A `user` file was seeded once and authored since; there is no current
		// derivation for it to be behind, and inventing one out of the stub would
		// report the slot machinery working as if it were rot.
		if (entry.ownership === 'user') {
			// The one thing that CAN have moved underneath it: the versioned
			// block-slot role vocabulary its fills were written against. Comparing
			// the recorded version rather than the bytes is what makes this a signal
			// instead of the manufactured drift the byte comparison would produce.
			const authoredAgainst = entry.rolesVersion
			const stale =
				authoredAgainst !== undefined &&
				authoredAgainst !== BLOCK_SLOT_ROLES_VERSION
			owned.push({
				...base,
				status: 'authored',
				...(stale && authoredAgainst !== undefined
					? {
							rolesDrift: {
								authored: authoredAgainst,
								current: BLOCK_SLOT_ROLES_VERSION,
							},
						}
					: {}),
				explanation: stale
					? `yours from the start — never derived again, so it cannot fall behind ` +
						`by content. Its slots were authored against block-slot roles v${authoredAgainst} ` +
						`and the platform is on v${BLOCK_SLOT_ROLES_VERSION}: the props a slot is called ` +
						'with may have changed. Nothing will be applied — "maxstack slots" lists the current roles'
					: 'yours from the start — the generator seeded this once and never ' +
						'derives it again, so there is nothing for it to fall behind',
			})
			continue
		}

		const target = byId.get(entry.id)
		if (!target) {
			owned.push({
				...base,
				status: 'underived',
				explanation: underivedExplanation(base.family),
			})
			continue
		}

		const current = await fs.read(entry.file)
		if (current === target.nextContent) {
			owned.push({
				...base,
				status: 'in-sync',
				explanation:
					'byte-identical to what the generator would emit today — owned, but ' +
					'not yet diverged',
			})
			continue
		}

		const patch = createPatch(
			entry.file,
			target.nextContent,
			current,
			'current derivation',
			'your file',
		)
		const { ahead, behind } = countChangedLines(patch)
		owned.push({
			...base,
			status: 'drifted',
			ahead,
			behind,
			patch,
			explanation:
				`${ahead} line(s) of yours the derivation does not have, ${behind} line(s) ` +
				'of the derivation yours does not. Nothing will be applied — this is the ' +
				'eject tax, itemized',
		})
	}

	owned.sort((a, b) => a.file.localeCompare(b.file))
	const count = (status: DriftStatus) =>
		owned.filter((o) => o.status === status).length
	return {
		owned,
		ownedCount: owned.length,
		driftedCount: count('drifted'),
		inSyncCount: count('in-sync'),
		authoredCount: count('authored'),
		underivedCount: count('underived'),
		missingCount: count('missing'),
		rolesDriftCount: owned.filter((o) => o.rolesDrift !== undefined).length,
	}
}

/**
 * The one line `gen` / `upgrade` may print about drift. Deliberately one line,
 * deliberately pointing elsewhere: a wall of diffs after every regeneration is
 * how a signal gets ignored.
 *
 * Returns `undefined` when there is nothing worth saying — including when files
 * are owned but none has drifted, because "0 drifted" is not news.
 */
export function driftSummaryLine(
	report: OwnershipDriftReport,
): string | undefined {
	const notable =
		report.driftedCount + report.missingCount + report.rolesDriftCount
	if (notable === 0) return undefined
	const parts: string[] = []
	if (report.driftedCount > 0) {
		parts.push(
			`${report.driftedCount} owned file(s) have drifted from the current derivation`,
		)
	}
	if (report.missingCount > 0) {
		parts.push(`${report.missingCount} tracked as yours but not on disk`)
	}
	// Worth a line for the same reason drift is: it is a change under a file you
	// own that you would otherwise only find by reading the release notes.
	if (report.rolesDriftCount > 0) {
		parts.push(
			`${report.rolesDriftCount} authored against an older block-slot role version`,
		)
	}
	return `· ${parts.join('; ')} — "maxstack drift" shows what changed (nothing will be applied)`
}

/** The full report, formatted for a terminal. */
export function formatOwnershipDrift(
	report: OwnershipDriftReport,
	options: { patches?: boolean } = {},
): string {
	if (report.ownedCount === 0) {
		return 'You own nothing yet — no ejected files, no filled slots. Nothing to report.'
	}
	const lines = [
		`${report.ownedCount} owned file(s): ${report.inSyncCount} in sync, ` +
			`${report.driftedCount} drifted, ${report.authoredCount} authored, ` +
			`${report.underivedCount} underived, ${report.missingCount} missing` +
			(report.rolesDriftCount > 0
				? ` (${report.rolesDriftCount} authored against an older slot-role version)`
				: ''),
		'',
	]
	for (const entry of report.owned) {
		lines.push(
			`  ${entry.status.padEnd(10)} ${entry.file}  (${entry.ownership})`,
		)
		lines.push(`             ${entry.explanation}`)
		if (options.patches && entry.patch) {
			lines.push('')
			for (const line of entry.patch.split('\n')) lines.push(`    ${line}`)
		}
	}
	lines.push(
		'',
		'Drift is not a problem to fix. It is the cost of owning a file, made visible.',
	)
	return lines.join('\n')
}
