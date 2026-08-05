/**
 * The feedback source shared by the review-queue host and the AI
 * cluster trigger: real captured feedback when there is any, else a
 * small demo backlog so the inbox isn't empty on a fresh project. Split out
 * of `review-queue.server` so `ai-cluster.server` can read the same source
 * without an import cycle (the AI cluster snapshot it produces is in turn
 * read back by `review-queue.server`).
 */

import type { Feedback } from '@maxstack/spec'
import { allFeedback } from './feedback.server'

/** A small demo backlog so the inbox is populated on a fresh project (mirrors the
 *  workbench's demo-spec seeding). Used only when nothing real has been captured. */
export const DEMO_FEEDBACK: Feedback[] = [
	{
		id: 'demo-1',
		at: '2026-07-11T09:00:00.000Z',
		source: 'end-user',
		target: { kind: 'field', id: 'title', parentId: 'task' },
		kind: 'request',
		body: 'The "title" field label reads lowercase — please capitalize it.',
		specVersion: 'gen-1',
		severity: 'low',
	},
	{
		id: 'demo-2',
		at: '2026-07-11T09:05:00.000Z',
		source: 'end-user',
		target: { kind: 'field', id: 'title', parentId: 'task' },
		kind: 'request',
		body: 'Same here — field labels should be Title Case.',
		specVersion: 'gen-1',
	},
	{
		id: 'demo-3',
		at: '2026-07-11T09:10:00.000Z',
		source: 'end-user',
		target: { kind: 'page', id: 'inbox' },
		kind: 'request',
		body: 'I want to bulk-archive tasks from the inbox.',
		specVersion: 'gen-1',
		severity: 'high',
	},
	{
		id: 'demo-4',
		at: '2026-07-11T09:12:00.000Z',
		source: 'end-user',
		target: { kind: 'page', id: 'inbox' },
		kind: 'bug',
		body: 'Archiving one task sometimes archives the whole project.',
		specVersion: 'gen-1',
		severity: 'high',
	},
	{
		id: 'demo-5',
		at: '2026-07-11T09:20:00.000Z',
		source: 'telemetry',
		target: { kind: 'block', id: 'assignee-picker', parentId: 'task-detail' },
		kind: 'confusion',
		body: 'Repeated focus/reject churn on the assignee picker.',
		specVersion: 'gen-1',
		severity: 'med',
	},
]

/** The data source: real captured feedback, or the demo backlog when empty. */
export async function sourceFeedback(): Promise<Feedback[]> {
	const captured = await allFeedback()
	return captured.length > 0 ? captured : DEMO_FEEDBACK
}
