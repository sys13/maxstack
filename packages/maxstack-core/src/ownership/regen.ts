/**
 * Regeneration-as-diff (bet B) + the regeneration-safety suite. Two things live here:
 *
 *  1. `regenerateAsDiff` — on a spec change, re-derive the affected files and
 *     return a REVIEWABLE unified diff instead of overwriting anything. Files
 *     the manifest marks `ejected`/`user` are reported as protected and never
 *     diffed for overwrite. Nothing is written; `applyReviewedDiff` lands the
 *     result and only through the validate gate.
 *
 *  2. `checkRegenSafety` / `checkProvenanceInvariants` — the executable safety
 *     check that must pass on every regeneration (§6: "100%, not a target").
 *     File-level never-clobber lives here; the data-level provenance invariants
 *     mirror `@maxstack/spec`'s `partitionForRegen`/`getAcceptedOrAll` so the
 *     harness can assert both without crossing the layer boundary.
 */

import { createPatch } from 'diff'
import {
	findEntry,
	hashContent,
	type RouteManifest,
	type RouteManifestEntry,
	upsertEntry,
} from './manifest.ts'
import type { Fs } from './write.ts'

/** One file's worth of a proposed regeneration. */
export interface RegenTarget {
	id: string
	file: string
	routePath: string
	slotFile?: string
	/** Freshly emitted content the generator would write. */
	nextContent: string
}

export type RegenStatus = 'new' | 'modified' | 'unchanged' | 'protected'

export interface RegenFileReview {
	id: string
	file: string
	status: RegenStatus
	/** Unified diff (empty for `unchanged`; the whole file for `new`). */
	patch: string
	/** Why a `protected` file was left alone. */
	protectedReason?: 'ejected' | 'user'
}

export interface RegenReview {
	files: RegenFileReview[]
	/** True when at least one file would change — i.e. there is something to land. */
	hasChanges: boolean
}

/**
 * Produce a reviewable diff for a set of regeneration targets. Reads current
 * on-disk content through `fs`, compares to `nextContent`, and classifies each
 * file. Protected files (ejected/user-owned per the manifest) are surfaced but
 * never proposed for overwrite — the never-clobber invariant enforced up front,
 * before any write is even contemplated.
 */
export async function regenerateAsDiff(
	fs: Fs,
	manifest: RouteManifest,
	targets: RegenTarget[],
): Promise<RegenReview> {
	const files: RegenFileReview[] = []

	for (const target of targets) {
		const entry = findEntry(manifest, target.id)
		if (entry && entry.ownership !== 'generated') {
			files.push({
				id: target.id,
				file: entry.file,
				status: 'protected',
				patch: '',
				protectedReason: entry.ownership,
			})
			continue
		}

		const exists = await fs.exists(target.file)
		const current = exists ? await fs.read(target.file) : ''
		if (current === target.nextContent) {
			files.push({
				id: target.id,
				file: target.file,
				status: 'unchanged',
				patch: '',
			})
			continue
		}
		const patch = createPatch(target.file, current, target.nextContent)
		files.push({
			id: target.id,
			file: target.file,
			status: exists ? 'modified' : 'new',
			patch,
		})
	}

	return {
		files,
		hasChanges: files.some(
			(f) => f.status === 'modified' || f.status === 'new',
		),
	}
}

export interface ApplyResult {
	manifest: RouteManifest
	written: string[]
	/** Set when the gate rejected the change — nothing was written. */
	rejected?: string
}

/**
 * Land a reviewed regeneration — but only if the validate gate passes. The gate
 * is an injected async predicate (`typecheck && lint && test && …`); if it
 * returns a failure the whole batch is rolled back to a no-op (nothing was
 * written yet, so rollback is free). This is the "lands only through the
 * validate gate + never-clobber invariants" contract for bet B.
 */
export async function applyReviewedDiff(
	fs: Fs,
	manifest: RouteManifest,
	targets: RegenTarget[],
	review: RegenReview,
	gate: () => Promise<{ ok: boolean; reason?: string }>,
): Promise<ApplyResult> {
	const landable = review.files.filter(
		(f) => f.status === 'modified' || f.status === 'new',
	)
	if (landable.length === 0) return { manifest, written: [] }

	const verdict = await gate()
	if (!verdict.ok) {
		return {
			manifest,
			written: [],
			rejected: verdict.reason ?? 'validate gate failed',
		}
	}

	let next = manifest
	const written: string[] = []
	const byId = new Map(targets.map((t) => [t.id, t]))
	for (const f of landable) {
		const target = byId.get(f.id)
		if (!target) continue
		await fs.write(target.file, target.nextContent)
		const entry: RouteManifestEntry = {
			id: target.id,
			routePath: target.routePath,
			file: target.file,
			ownership: 'generated',
			slotFile: target.slotFile,
			hash: hashContent(target.nextContent),
		}
		next = upsertEntry(next, entry)
		written.push(target.file)
	}
	return { manifest: next, written }
}

// ── Regeneration-safety suite ────────────────────────────────────────────────

export interface FsSnapshot {
	manifest: RouteManifest
	files: Map<string, string>
}

export interface SafetyViolation {
	file: string
	invariant: 'never-clobber' | 'ownership-preserved'
	detail: string
}

/**
 * The file-level regeneration-safety check. Given the before/after snapshots of
 * a regeneration, assert that nothing the user owns moved:
 *   - every `ejected`/`user` file present before is byte-identical after;
 *   - no entry silently changed ownership away from `ejected`/`user`.
 * Returns the violations (empty = safe). The harness treats any non-empty
 * result as a hard failure — the change does not land.
 */
export function checkRegenSafety(
	before: FsSnapshot,
	after: FsSnapshot,
): SafetyViolation[] {
	const violations: SafetyViolation[] = []
	const afterById = new Map(after.manifest.entries.map((e) => [e.id, e]))

	for (const entry of before.manifest.entries) {
		if (entry.ownership === 'generated') continue

		const post = afterById.get(entry.id)
		if (post && post.ownership === 'generated') {
			violations.push({
				file: entry.file,
				invariant: 'ownership-preserved',
				detail: `ownership regressed ${entry.ownership} → generated`,
			})
		}

		const beforeContent = before.files.get(entry.file)
		const afterContent = after.files.get(entry.file)
		if (beforeContent !== undefined && beforeContent !== afterContent) {
			violations.push({
				file: entry.file,
				invariant: 'never-clobber',
				detail: `${entry.ownership} file was modified by regeneration`,
			})
		}
	}
	return violations
}

/** Minimal shape of a provenanced row — mirrors `@maxstack/spec`'s flags. */
export interface ProvenancedRow {
	isAddedManually?: boolean
	isAccepted?: boolean
}

export interface ProvenanceViolation {
	invariant: 'manual-survives' | 'grounds-on-accepted'
	detail: string
}

/**
 * The data-level provenance invariants, executable against generic provenanced
 * rows (kept structural so this file needn't import the L1 spec package):
 *   - manual-survives: every `isAddedManually` row in `before` is still present
 *     in `after` (regeneration never deletes manual items);
 *   - grounds-on-accepted: the grounding set a generator was given contained no
 *     unaccepted rows (generation grounds only on accepted items).
 *
 * Row identity is by the caller-supplied `keyOf`.
 */
export function checkProvenanceInvariants<T extends ProvenancedRow>(
	before: T[],
	after: T[],
	grounding: T[],
	keyOf: (row: T) => string,
): ProvenanceViolation[] {
	const violations: ProvenanceViolation[] = []
	const afterKeys = new Set(after.map(keyOf))

	for (const row of before) {
		if (row.isAddedManually && !afterKeys.has(keyOf(row))) {
			violations.push({
				invariant: 'manual-survives',
				detail: `manual row ${keyOf(row)} was deleted by regeneration`,
			})
		}
	}
	for (const row of grounding) {
		if (row.isAccepted === false) {
			violations.push({
				invariant: 'grounds-on-accepted',
				detail: `generation grounded on unaccepted row ${keyOf(row)}`,
			})
		}
	}
	return violations
}
