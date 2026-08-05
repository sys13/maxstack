/**
 * The telemetry store host — disk-backed JSONL when the app has a data dir
 * (append one line per event to `telemetry.jsonl`, exactly the format the pure
 * serialize/parse in {@link ./telemetry} speaks), an in-memory `globalThis`
 * log otherwise (unit tests). Mirrors the harness metrics DB split
 * (`memoryRunStore`/`nodeRunStore`): the pure fold is shared, only the host
 * differs. The interaction record is durable across dev-server restarts — §5's
 * "interaction events flowing" now leaves a file behind.
 */

import { resolveDataDir } from '~/data-dir.server'
import {
	parseEvents,
	recentEvents,
	serializeEvent,
	summarizeEvents,
	type TelemetrySummary,
	type WorkbenchEvent,
	type WorkbenchEventKind,
} from './telemetry'

const scope = globalThis as typeof globalThis & {
	__maxstackWorkbenchEvents?: WorkbenchEvent[]
}

function memoryLog(): WorkbenchEvent[] {
	scope.__maxstackWorkbenchEvents ??= []
	return scope.__maxstackWorkbenchEvents
}

async function telemetryPath(): Promise<string | null> {
	const dir = resolveDataDir()
	if (!dir) return null
	const { join } = await import('node:path')
	return join(dir, 'telemetry.jsonl')
}

/**
 * Append one interaction event (wall-clock timestamp stamped here).
 *
 * `mode`/`batchSize`/`proposedAt` are the review-cost facts and are
 * written verbatim when supplied. They are recorded *unconditionally* while the
 * cost *reporting* is opt-in (`review-cost.server.ts`): the event log predates
 * #201 and is load-bearing for the activity feed and the confusion signals, so
 * gating the append would break features that have nothing to do with metrics.
 * Three extra optional fields on a line already being written is not the part
 * that needed consent — deriving and publishing numbers from it is.
 */
export async function recordEvent(
	kind: WorkbenchEventKind,
	opts: {
		targetId?: string
		detail?: string
		mode?: 'individual' | 'bulk'
		batchSize?: number
		proposedAt?: string
	} = {},
): Promise<void> {
	const event: WorkbenchEvent = {
		kind,
		at: new Date().toISOString(),
		targetId: opts.targetId,
		detail: opts.detail,
		mode: opts.mode,
		batchSize: opts.batchSize,
		proposedAt: opts.proposedAt,
	}
	const path = await telemetryPath()
	if (!path) {
		memoryLog().push(event)
		return
	}
	const { appendFile, mkdir } = await import('node:fs/promises')
	const { dirname } = await import('node:path')
	await mkdir(dirname(path), { recursive: true })
	await appendFile(path, `${serializeEvent(event)}\n`)
}

/** Every recorded interaction event, oldest-first — exposed so implicit
 * confusion detection
 *  can fold over the same log without a parallel store. */
export async function allWorkbenchEvents(): Promise<WorkbenchEvent[]> {
	return allEvents()
}

async function allEvents(): Promise<WorkbenchEvent[]> {
	const path = await telemetryPath()
	if (!path) return memoryLog()
	const { readFile } = await import('node:fs/promises')
	try {
		return parseEvents(await readFile(path, 'utf8'))
	} catch (err) {
		if ((err as NodeJS.ErrnoException).code === 'ENOENT') return []
		throw err
	}
}

export interface TelemetryView {
	summary: TelemetrySummary
	recent: WorkbenchEvent[]
}

/** The telemetry pane's data — a summary plus the newest-first activity feed. */
export async function telemetryView(): Promise<TelemetryView> {
	const events = await allEvents()
	return { summary: summarizeEvents(events), recent: recentEvents(events) }
}
