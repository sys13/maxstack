/**
 * Where a reported defect lands for a project on disk.
 *
 * `defects.jsonl` at the **project root**, not under the gitignored data dir.
 * A defect report is a durable artifact about the platform, worth keeping and
 * worth sharing; putting it somewhere `git status` never mentions is how it
 * becomes a file nobody reads. Append-only JSONL so several sessions can add to
 * it without coordinating, and so it aggregates.
 *
 * The one thing this must not do is fail loudly enough to discourage reporting.
 * An agent that hits a framework bug is already off its task; if filing the
 * report can itself throw, the next agent stops filing.
 */

import { resolve } from 'node:path'
import type { DefectReport } from '@maxstack/mcp'

export const DEFECTS_FILENAME = 'defects.jsonl'

/** Append one report; returns the path it landed in. */
export async function recordDefect(
	root: string,
	report: DefectReport,
): Promise<string> {
	const { appendFile } = await import('node:fs/promises')
	const path = resolve(root, DEFECTS_FILENAME)
	await appendFile(path, `${JSON.stringify(report)}\n`, 'utf8')
	return DEFECTS_FILENAME
}

/** Every defect reported in this project, oldest first. */
export async function readDefects(root: string): Promise<DefectReport[]> {
	const { readFile } = await import('node:fs/promises')
	try {
		return (await readFile(resolve(root, DEFECTS_FILENAME), 'utf8'))
			.split('\n')
			.map((l) => l.trim())
			.filter((l) => l.length > 0)
			.map((l) => JSON.parse(l) as DefectReport)
	} catch (err) {
		if ((err as NodeJS.ErrnoException).code === 'ENOENT') return []
		throw err
	}
}
