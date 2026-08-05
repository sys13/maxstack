/**
 * **Digests on the job queue**.
 *
 * Two job types, because the two halves fail differently. A *sweep* asks who is
 * due and enqueues one job each; a *digest* mails one recipient. Splitting them
 * means one recipient's mailer error retries that recipient rather than
 * re-running the whole fan-out, and it means the sweep can be a plain interval
 * (`scheduleInterval`) with no payload of its own.
 *
 * Both handlers are safe to run twice, which is the only property that matters
 * here: `JobQueue` retries with exponential backoff and dead-letters after
 * `maxAttempts`, so *every* handler it runs will eventually be run again with
 * the same input. A duplicate sweep enqueues duplicate digest jobs; those
 * collapse against the (user, window) claim in `sendDigest`, so the second one
 * reports `duplicate` and mails nothing. That is the chain the
 * duplicate-suppression test walks end to end.
 */

import type { JobQueue } from '../jobs/service.ts'
import type { DigestResult, NotificationService } from './service.ts'

/** Enqueued per recipient; mails one digest. */
export const DIGEST_JOB_TYPE = 'notification-digest'

/** Enqueued on a schedule; fans out into one {@link DIGEST_JOB_TYPE} per recipient. */
export const DIGEST_SWEEP_JOB_TYPE = 'notification-digest-sweep'

export interface DigestRecipient {
	userId: string
	email: string
}

export interface DigestJobPayload extends DigestRecipient {
	/** Pinned by the sweep so every job in one fan-out claims the same window,
	 * even if a retry runs it minutes later — or a day later, across a boundary
	 * the recipient's cadence would otherwise have moved. */
	windowKey?: string
}

export interface DigestJobOptions {
	/**
	 * The service, or a thunk resolving it. The thunk exists for composition
	 * roots that build the queue before the service: the app template's queue is
	 * a process-lifetime singleton that the notification wiring itself depends
	 * on, so resolving eagerly here would be a circular import.
	 */
	service:
		| NotificationService
		| (() => NotificationService | Promise<NotificationService>)
	/** Who is due a digest. The app owns this query: it is the only side that
	 * knows which users exist and what address to use. */
	recipients: () =>
		| Promise<readonly DigestRecipient[]>
		| readonly DigestRecipient[]
	/** Overrides the window key the sweep pins. Tests use it; production does
	 * not need to. */
	windowKey?: () => string
}

/**
 * Register both handlers on `queue`. Call once at the composition root, then
 * either schedule the sweep (`scheduleInterval(queue, { type:
 * DIGEST_SWEEP_JOB_TYPE, intervalMs })`) or enqueue it by hand.
 */
export function registerDigestJobs(
	queue: JobQueue,
	opts: DigestJobOptions,
): void {
	queue.register(DIGEST_SWEEP_JOB_TYPE, async () => {
		const recipients = await opts.recipients()
		const windowKey = opts.windowKey?.()
		for (const recipient of recipients) {
			await queue.enqueue({
				type: DIGEST_JOB_TYPE,
				payload: { ...recipient, ...(windowKey ? { windowKey } : {}) },
			})
		}
		return { enqueued: recipients.length }
	})

	queue.register<DigestJobPayload, DigestResult>(
		DIGEST_JOB_TYPE,
		async (payload) => {
			if (!payload?.userId || !payload.email)
				throw new Error('notification-digest job needs a userId and an email')
			const service =
				typeof opts.service === 'function' ? await opts.service() : opts.service
			return service.sendDigest(payload.userId, payload.email, {
				...(payload.windowKey ? { windowKey: payload.windowKey } : {}),
			})
		},
	)
}
