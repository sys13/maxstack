/**
 * The AI cluster trigger + snapshot store — the explicit-invocation boundary
 * for the real Cluster step.
 *
 * `clustering.ts`'s `groupByTarget` baseline is always-on (it's cheap,
 * deterministic, and offline); the real `aiClusterFn` is NOT wired into the
 * review-queue loader directly — an AI call must never fire as a side effect
 * of loading a page or capturing feedback. Instead a maintainer explicitly
 * triggers `runAiClustering()` (the workbench's "Cluster feedback" button, see
 * `workbench.tsx`'s `cluster` intent), and its result is persisted as a
 * snapshot. `review-queue.server`'s loader reads the snapshot back and, when
 * present, uses it at the `clusterFeedback` `cluster` seam in place of the
 * baseline — so once triggered, AI-clustered Issues render as ordinary
 * suggested rows in the same queue, no separate UI needed.
 *
 * Same host split as `feedback.server`/`issue-review.server`: disk-backed JSON
 * under `MAXSTACK_DATA_DIR`, an in-memory `globalThis` fallback under tests. A
 * snapshot (not an append-only log) — each run supersedes the last, since
 * re-clustering is idempotent-ish by design (the underlying `Issue`s are
 * re-derived from feedback + this snapshot on every load; the persisted triage
 * decisions in `issue-review.server` are what actually needs append-only
 * durability).
 */

import { selectAiClient } from '@maxstack/spec-derive'
import {
	aiClusterFn,
	type ProposedCluster,
} from '@maxstack/spec-derive/clustering'
import { resolveDataDir } from '~/data-dir.server'
import { sourceFeedback } from './feedback-source.server'

interface ClusterSnapshot {
	at: string
	feedbackCount: number
	clusters: ProposedCluster[]
}

const scope = globalThis as typeof globalThis & {
	__maxstackAiClusters?: ClusterSnapshot
}

async function snapshotPath(): Promise<string | null> {
	const dir = resolveDataDir()
	if (!dir) return null
	const { join } = await import('node:path')
	return join(dir, 'ai-clusters.json')
}

/** The most recent AI cluster run's output, or `null` if none has ever run
 *  (the queue falls back to `groupByTarget` in that case). */
export async function loadAiClusterSnapshot(): Promise<
	ProposedCluster[] | null
> {
	const path = await snapshotPath()
	if (!path) return scope.__maxstackAiClusters?.clusters ?? null
	const { readFile } = await import('node:fs/promises')
	try {
		const raw = await readFile(path, 'utf8')
		return (JSON.parse(raw) as ClusterSnapshot).clusters
	} catch (err) {
		if ((err as NodeJS.ErrnoException).code === 'ENOENT') return null
		throw err
	}
}

export interface RunClusteringResult {
	clusterCount: number
	feedbackCount: number
	/** Set when the AI call failed (e.g. no API key, no MOCK_AI) — the run is a
	 *  no-op rather than a crash; the existing snapshot (if any) is untouched. */
	error?: string
}

/**
 * The explicit trigger: run the real AI clusterer over the current feedback
 * and persist the result. Never called implicitly — every caller is a
 * deliberate maintainer action (a form submission today; a CLI command or MCP
 * tool could wire the same function in later without touching this seam).
 */
export async function runAiClustering(): Promise<RunClusteringResult> {
	const feedback = await sourceFeedback()
	let clusters: ProposedCluster[]
	try {
		clusters = await aiClusterFn(selectAiClient())(feedback)
	} catch (err) {
		return {
			clusterCount: 0,
			feedbackCount: feedback.length,
			error: err instanceof Error ? err.message : String(err),
		}
	}
	const snapshot: ClusterSnapshot = {
		at: new Date().toISOString(),
		feedbackCount: feedback.length,
		clusters,
	}
	const path = await snapshotPath()
	if (!path) {
		scope.__maxstackAiClusters = snapshot
	} else {
		const { writeFile, mkdir } = await import('node:fs/promises')
		const { dirname } = await import('node:path')
		await mkdir(dirname(path), { recursive: true })
		await writeFile(path, JSON.stringify(snapshot, null, 2))
	}
	return { clusterCount: clusters.length, feedbackCount: feedback.length }
}
