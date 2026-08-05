/**
 * The issue-review decision store — where a maintainer's accept/reject triage
 * on a clustered {@link Issue} persists.
 *
 * Issues are *derived* fresh from feedback on every load (clustering is not
 * stored), so the triage decision can't live on the issue object — it is keyed
 * by the issue's *stable* {@link issueKey} (its coordinate set) and kept here in
 * an append-only JSONL log, latest-wins per key. Same host split and format as
 * {@link ./feedback.server} and the harness metrics DB. `clear` is a first-class
 * decision so an **Undo** returns a row to `suggested` without rewriting history.
 */

import type { Issue } from '@maxstack/spec-derive/clustering'
import {
	acceptIssue,
	issueKey,
	rejectIssue,
} from '@maxstack/spec-derive/clustering'
import { resolveDataDir } from '~/data-dir.server'

export type ReviewDecision = 'accept' | 'reject' | 'clear'

export interface DecisionRecord {
	issueKey: string
	decision: ReviewDecision
	at: string
}

const scope = globalThis as typeof globalThis & {
	__maxstackIssueDecisions?: DecisionRecord[]
}

function memoryLog(): DecisionRecord[] {
	scope.__maxstackIssueDecisions ??= []
	return scope.__maxstackIssueDecisions
}

async function decisionPath(): Promise<string | null> {
	const dir = resolveDataDir()
	if (!dir) return null
	const { join } = await import('node:path')
	return join(dir, 'issue-decisions.jsonl')
}

/** Append one triage decision (timestamp stamped here). */
export async function recordDecision(
	issueKey: string,
	decision: ReviewDecision,
): Promise<void> {
	const record: DecisionRecord = {
		issueKey,
		decision,
		at: new Date().toISOString(),
	}
	const path = await decisionPath()
	if (!path) {
		memoryLog().push(record)
		return
	}
	const { appendFile, mkdir } = await import('node:fs/promises')
	const { dirname } = await import('node:path')
	await mkdir(dirname(path), { recursive: true })
	await appendFile(path, `${JSON.stringify(record)}\n`)
}

async function allDecisions(): Promise<DecisionRecord[]> {
	const path = await decisionPath()
	if (!path) return memoryLog()
	const { readFile } = await import('node:fs/promises')
	try {
		return (await readFile(path, 'utf8'))
			.split('\n')
			.map((l) => l.trim())
			.filter((l) => l.length > 0)
			.map((l) => JSON.parse(l) as DecisionRecord)
	} catch (err) {
		if ((err as NodeJS.ErrnoException).code === 'ENOENT') return []
		throw err
	}
}

/**
 * The effective decision per issue key (latest-wins over the append-only log).
 * A `clear` drops the key back to undecided, so it never appears in the map.
 */
export function foldDecisions(
	records: readonly DecisionRecord[],
): Map<string, 'accept' | 'reject'> {
	const map = new Map<string, 'accept' | 'reject'>()
	for (const r of records) {
		if (r.decision === 'clear') map.delete(r.issueKey)
		else map.set(r.issueKey, r.decision)
	}
	return map
}

/**
 * Apply the persisted triage decisions to freshly-clustered issues, transitioning
 * each matched issue's provenance through the existing accept/reject machine. An
 * issue with no recorded decision stays `suggested`. Pure given the decision map.
 */
export function applyDecisions(
	issues: readonly Issue[],
	decisions: ReadonlyMap<string, 'accept' | 'reject'>,
): Issue[] {
	return issues.map((issue) => {
		const decision = decisions.get(issueKey(issue))
		if (decision === 'accept') return acceptIssue(issue)
		if (decision === 'reject') return rejectIssue(issue)
		return issue
	})
}

/** Load the effective decision map (latest-wins). */
export async function loadDecisions(): Promise<
	Map<string, 'accept' | 'reject'>
> {
	return foldDecisions(await allDecisions())
}
