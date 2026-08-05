/**
 * The regeneration ledger's host — the append at the end of a
 * `maxstack gen`, and the read behind `maxstack regen-cost`.
 *
 * The same split `review-cost.ts` uses: `@maxstack/core/regen` holds the types,
 * the codec and the fold with no I/O and no clock, and this file is the only
 * thing that touches a disk.
 *
 * The ledger sits in the project's data dir beside `telemetry.jsonl`, because it
 * is the same kind of thing — a local, append-only record about this project that
 * nothing else reads. It is not in the app tree: it is not generated output and
 * regenerating must never rewrite it.
 */

import { appendFile, mkdir, readFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import type { WriteResult } from '@maxstack/core/ownership'
import {
	foldRegenTrend,
	type RegenEntry,
	type RegenTrendReport,
	parseRegenLog,
	serializeRegenEntry,
} from '@maxstack/core/regen'
import type { ProjectConfig } from './project.ts'

export const REGEN_LOG_FILENAME = 'regen-log.jsonl'

/** Turn a run's write results into the entry that records it. */
export function regenEntry(
	writes: readonly WriteResult[],
	artifacts: readonly string[],
	opCount: number,
	at: string,
): RegenEntry {
	const count = (action: WriteResult['action']): number =>
		writes.filter((w) => w.action === action).length
	return {
		at,
		opCount,
		writes: {
			created: count('created'),
			overwritten: count('overwritten'),
			unchanged: count('unchanged'),
			skippedUserOwned: count('skipped-user-owned'),
		},
		artifacts: artifacts.length,
		// The same rule `isRegenStable` states, kept here rather than imported so
		// the recorded fact and the printed one cannot drift apart: a run is stable
		// when it rewrote nothing.
		stable: writes.every(
			(w) => w.action === 'unchanged' || w.action === 'skipped-user-owned',
		),
	}
}

/**
 * Append one run to the ledger.
 *
 * Creates the data dir first. A project's first `gen` runs before anything has
 * put a `.maxstack/` on disk, so without this every ledger would start on the
 * *second* generation — and because the append below never throws, that would
 * have been silent. It was: the swallow hid it until a test asked the ledger how
 * many lines it had. Worth stating, because it is the standing hazard of a
 * best-effort write.
 *
 * Never throws, deliberately. A project on a read-only mount still gets its files
 * generated: the ledger is a record *about* the work, and failing the work to
 * protect the record would be exactly backwards. The cost of a swallowed failure
 * is a gap in a trend, which the fold already treats as its normal case.
 */
export async function appendRegenEntry(
	dataDir: string,
	entry: RegenEntry,
): Promise<void> {
	try {
		await mkdir(dataDir, { recursive: true })
		await appendFile(
			resolve(dataDir, REGEN_LOG_FILENAME),
			serializeRegenEntry(entry),
			'utf8',
		)
	} catch {
		// See above: the ledger never fails a generate.
	}
}

/**
 * A project's ledger. An absent file is an empty ledger, not an error — it is the
 * state every project starts in.
 */
export async function readRegenLog(dataDir: string): Promise<RegenEntry[]> {
	try {
		return parseRegenLog(
			await readFile(resolve(dataDir, REGEN_LOG_FILENAME), 'utf8'),
		)
	} catch (err) {
		if ((err as NodeJS.ErrnoException).code === 'ENOENT') return []
		throw err
	}
}

/** The trend report for a project on disk. */
export async function projectRegenTrend(project: {
	root: string
	config: ProjectConfig
}): Promise<RegenTrendReport> {
	const dataDir = resolve(project.root, project.config.dataDir)
	return foldRegenTrend(await readRegenLog(dataDir))
}
