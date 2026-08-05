/**
 * The feedback store host — the *demand-side* twin of {@link ./telemetry.server}
 *. Disk-backed JSONL when the app has a data
 * dir (append one line per event to `feedback.jsonl`, exactly the format the
 * pure serialize/parse in `@maxstack/spec` speaks), an in-memory `globalThis`
 * log otherwise (unit tests).
 *
 * Same host split as telemetry and the harness metrics DB: the pure fold
 * (`summarizeFeedback`) is shared, only the host differs. Single-tenant direct
 * data-dir write — the settled #9 decision; a collection endpoint waits until
 * apps go multi-user.
 */

import {
	type Feedback,
	type FeedbackKind,
	type FeedbackSeverity,
	type FeedbackSource,
	type FeedbackSummary,
	parseFeedbackLog,
	type ReviewTarget,
	recentFeedback,
	serializeFeedback,
	summarizeFeedback,
} from '@maxstack/spec'
import { resolveDataDir } from '~/data-dir.server'

const scope = globalThis as typeof globalThis & {
	__maxstackFeedback?: Feedback[]
}

function memoryLog(): Feedback[] {
	scope.__maxstackFeedback ??= []
	return scope.__maxstackFeedback
}

async function feedbackPath(): Promise<string | null> {
	const dir = resolveDataDir()
	if (!dir) return null
	const { join } = await import('node:path')
	return join(dir, 'feedback.jsonl')
}

/** What a capture call supplies — the host stamps `id` and `at`. */
export interface FeedbackInput {
	source: FeedbackSource
	target: ReviewTarget
	kind: FeedbackKind
	body: string
	specVersion: string
	actor?: string
	severity?: FeedbackSeverity
}

/** A monotonic-ish unique id without pulling in a uuid dep; unique per process
 *  tick, which is all an append-only log needs to distinguish rows. */
function nextId(existing: number): string {
	return `fb-${existing + 1}-${process.hrtime.bigint().toString(36)}`
}

/** Append one feedback event (id + wall-clock timestamp stamped here). */
export async function captureFeedback(input: FeedbackInput): Promise<Feedback> {
	const feedback: Feedback = {
		...input,
		at: new Date().toISOString(),
		id: '', // filled below once we know the current count
	}
	const path = await feedbackPath()
	if (!path) {
		const log = memoryLog()
		feedback.id = nextId(log.length)
		log.push(feedback)
		return feedback
	}
	const existing = await allFeedback()
	feedback.id = nextId(existing.length)
	const { appendFile, mkdir } = await import('node:fs/promises')
	const { dirname } = await import('node:path')
	await mkdir(dirname(path), { recursive: true })
	await appendFile(path, `${serializeFeedback(feedback)}\n`)
	return feedback
}

/** Every captured feedback event, oldest-first. */
export async function allFeedback(): Promise<Feedback[]> {
	const path = await feedbackPath()
	if (!path) return memoryLog()
	const { readFile } = await import('node:fs/promises')
	try {
		return parseFeedbackLog(await readFile(path, 'utf8'))
	} catch (err) {
		if ((err as NodeJS.ErrnoException).code === 'ENOENT') return []
		throw err
	}
}

export interface FeedbackView {
	summary: FeedbackSummary
	recent: Feedback[]
}

/** The capture pane's data — a summary (incl. per-target reach) plus the
 *  newest-first activity feed. */
export async function feedbackView(): Promise<FeedbackView> {
	const feed = await allFeedback()
	return { summary: summarizeFeedback(feed), recent: recentFeedback(feed) }
}
