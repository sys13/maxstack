import { beforeEach, describe, expect, it } from 'vitest'
import { createMemoryMailer } from '../email/mailer.ts'
import { EmailRegistry } from '../email/registry.ts'
import { createMemoryJobStore, JobQueue } from '../jobs/service.ts'
import { BUILT_IN_PREFERENCES } from '../preferences/definitions.ts'
import { PREFERENCES_DDL } from '../preferences/schema.ts'
import { PreferencesService } from '../preferences/service.ts'
import { usePglite } from '../testing/pglite-fixture.ts'
import {
	DIGEST_JOB_TYPE,
	DIGEST_SWEEP_JOB_TYPE,
	registerDigestJobs,
} from './digest.ts'
import { NOTIFICATIONS_DDL } from './schema.ts'
import { NotificationService } from './service.ts'
import { notificationPreferenceDefinitions } from './types.ts'

type Mailer = ReturnType<typeof createMemoryMailer>

let mailer: Mailer
let service: NotificationService
let queue: JobQueue

/** Drain the queue: `tick()` runs one due job per call and returns false when
 * idle, so a bounded loop empties everything the sweep fanned out. */
async function drain(max = 20): Promise<void> {
	for (let i = 0; i < max; i++) {
		if (!(await queue.tick())) return
	}
	throw new Error('queue did not drain')
}

const pg = usePglite(NOTIFICATIONS_DDL, PREFERENCES_DDL)

beforeEach(async () => {
	const db = pg.db
	mailer = createMemoryMailer()
	service = new NotificationService({
		db,
		mailer,
		registry: new EmailRegistry(),
		preferences: new PreferencesService({
			db,
			definitions: [
				...BUILT_IN_PREFERENCES,
				...notificationPreferenceDefinitions(),
			],
		}),
		unsubscribe: {
			secret: 'test-secret',
			baseUrl: 'https://app.example/unsubscribe',
		},
	})
	queue = new JobQueue({ store: createMemoryJobStore() })
	registerDigestJobs(queue, {
		service,
		recipients: () => [{ userId: 'u1', email: 'u1@example.com' }],
		windowKey: () => 'window-1',
	})

	await service.notify({
		userId: 'u1',
		type: 'invitation-accepted',
		title: 'New team member',
		body: 'alice@example.com joined.',
		email: 'u1@example.com',
	})
})

describe('digest jobs', () => {
	it('a sweep fans out one digest job per recipient and mails it', async () => {
		await queue.enqueue({ type: DIGEST_SWEEP_JOB_TYPE })
		await drain()

		const digests = await queue.list({ type: DIGEST_JOB_TYPE })
		expect(digests).toHaveLength(1)
		expect(digests[0]?.status).toBe('succeeded')
		expect(mailer.sent).toHaveLength(1)
	})

	it('a duplicated sweep — at-least-once — still produces exactly one email', async () => {
		await queue.enqueue({ type: DIGEST_SWEEP_JOB_TYPE })
		await queue.enqueue({ type: DIGEST_SWEEP_JOB_TYPE })
		await drain()

		const jobs = await queue.list({ type: DIGEST_JOB_TYPE })
		expect(jobs).toHaveLength(2)
		expect(mailer.sent).toHaveLength(1)
		// Both jobs *succeed* — the suppressed one reports that it sent nothing
		// rather than failing, because a dead-lettered digest job would page
		// someone for working correctly.
		expect(jobs.every((j) => j.status === 'succeeded')).toBe(true)
		const sent = jobs.filter(
			(j) => (j.result as { sent?: boolean } | null)?.sent === true,
		)
		expect(sent).toHaveLength(1)
	})

	it('two runs racing the same pending items collapse to one email', async () => {
		// Both jobs are enqueued *before* either runs, so the second still sees
		// the rows as pending — the case the (user, window) claim exists for,
		// rather than the easy one where the first run has already marked them.
		const payload = {
			userId: 'u1',
			email: 'u1@example.com',
			windowKey: 'window-1',
		}
		await queue.enqueue({ type: DIGEST_JOB_TYPE, payload })
		await queue.tick()
		await service.notify({
			userId: 'u1',
			type: 'invitation-accepted',
			title: 'Arrived between runs',
			body: 'carol@example.com joined.',
			email: 'u1@example.com',
		})
		await queue.enqueue({ type: DIGEST_JOB_TYPE, payload })
		await drain()

		expect(mailer.sent).toHaveLength(1)
		const [latest] = await queue.list({ type: DIGEST_JOB_TYPE })
		expect((latest?.result as { duplicate?: boolean } | null)?.duplicate).toBe(
			true,
		)
	})

	it('a redelivered digest job with the same payload sends nothing further', async () => {
		const payload = {
			userId: 'u1',
			email: 'u1@example.com',
			windowKey: 'window-1',
		}
		await queue.enqueue({ type: DIGEST_JOB_TYPE, payload })
		await queue.enqueue({ type: DIGEST_JOB_TYPE, payload })
		await drain()
		expect(mailer.sent).toHaveLength(1)
	})

	it('fails a digest job with no recipient rather than silently succeeding', async () => {
		await queue.enqueue({ type: DIGEST_JOB_TYPE, payload: { userId: 'u1' } })
		await drain()
		const [job] = await queue.list({ type: DIGEST_JOB_TYPE })
		expect(job?.error).toContain('needs a userId and an email')
	})

	it('a later window mails again', async () => {
		await queue.enqueue({
			type: DIGEST_JOB_TYPE,
			payload: { userId: 'u1', email: 'u1@example.com', windowKey: 'window-1' },
		})
		await drain()
		await service.notify({
			userId: 'u1',
			type: 'invitation-accepted',
			title: 'Another member',
			body: 'bob@example.com joined.',
			email: 'u1@example.com',
		})
		await queue.enqueue({
			type: DIGEST_JOB_TYPE,
			payload: { userId: 'u1', email: 'u1@example.com', windowKey: 'window-2' },
		})
		await drain()
		expect(mailer.sent).toHaveLength(2)
	})
})
