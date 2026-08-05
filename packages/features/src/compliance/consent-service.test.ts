import { drizzle } from 'drizzle-orm/pglite'
import { beforeEach, describe, expect, it } from 'vitest'
import { usePglite } from '../testing/pglite-fixture.ts'
import { ConsentService } from './consent-service.ts'
import { CONSENT_DDL } from './schema.ts'

// This suite used to be a chained narrative: one `beforeAll` database, and each
// test read the rows its predecessors had written ("re-accepting a bumped
// version" only had a v1 to bump *because* the test above it recorded one).
// Under `--sequence.shuffle --sequence.seed=42` three of the five failed
//. Worse than the flake: "has no acceptance on record until one is
// recorded" asserts `latest()` is null, which is true of an empty table and
// false of one a neighbour has written to — the assertion was only ever passing
// because of where it sat in the file.
//
// Each test now records the state it depends on, over the per-file fixture's
// truncated-between-tests database.
const pg = usePglite(CONSENT_DDL)

let service: ConsentService

beforeEach(() => {
	service = new ConsentService({ db: drizzle({ client: pg.client }) })
})

describe('ConsentService', () => {
	it('has no acceptance on record until one is recorded', async () => {
		expect(await service.latest('u1', 'terms')).toBeNull()
		expect(await service.hasAccepted('u1', 'terms', 'v1')).toBe(false)
	})

	it('records an acceptance and reads it back as the latest', async () => {
		const rec = await service.record({
			userId: 'u1',
			type: 'terms',
			version: 'v1',
		})
		expect(rec.userId).toBe('u1')
		expect(rec.type).toBe('terms')
		expect(rec.version).toBe('v1')
		expect(rec.acceptedAt).toBeInstanceOf(Date)

		expect(await service.hasAccepted('u1', 'terms', 'v1')).toBe(true)
		expect(await service.hasAccepted('u1', 'terms', 'v2')).toBe(false)
	})

	it('re-accepting a bumped version writes a new row instead of overwriting', async () => {
		await service.record({ userId: 'u1', type: 'terms', version: 'v1' })
		await service.record({ userId: 'u1', type: 'terms', version: 'v2' })
		const latest = await service.latest('u1', 'terms')
		expect(latest?.version).toBe('v2')

		const history = await service.history('u1')
		expect(history.map((h) => h.version)).toEqual(
			expect.arrayContaining(['v1', 'v2']),
		)
		expect(history.length).toBe(2)
	})

	// Isolating the tests above surfaced this: recorded back-to-back, both rows
	// carry the same `accepted_at`, and ordering on that column alone left the
	// winner to the query plan — `latest` returned v1 on two of five shuffle
	// seeds. It reads as a test detail and is not one: this is the read that
	// decides whether a user is re-prompted to accept new terms.
	it('breaks an acceptedAt tie by insertion order, not arbitrarily', async () => {
		// The tie is written explicitly rather than raced for: two `record()`
		// calls land in the same tick most of the time but not always, and a test
		// that only sometimes constructs its own precondition is no test at all.
		await pg.client.exec(`
			insert into consent (user_id, type, version, accepted_at) values
			  ('u1', 'terms', 'v1', timestamp '2026-08-02 12:00:00'),
			  ('u1', 'terms', 'v2', timestamp '2026-08-02 12:00:00')
		`)

		const [first, second] = await service.history('u1')
		expect(first?.acceptedAt.getTime()).toBe(second?.acceptedAt.getTime())
		expect(first?.version).toBe('v2')
		expect((await service.latest('u1', 'terms'))?.version).toBe('v2')
		expect(await service.hasAccepted('u1', 'terms', 'v2')).toBe(true)
	})

	it('tracks cookie consent independently of terms consent', async () => {
		await service.record({ userId: 'u1', type: 'terms', version: 'v2' })

		expect(await service.latest('u1', 'cookies')).toBeNull()
		await service.record({ userId: 'u1', type: 'cookies', version: '1' })
		expect(await service.hasAccepted('u1', 'cookies', '1')).toBe(true)
		// terms is unaffected
		expect(await service.hasAccepted('u1', 'terms', 'v2')).toBe(true)
	})

	it('scopes to the requested user only', async () => {
		await service.record({ userId: 'u1', type: 'terms', version: 'v1' })
		await service.record({ userId: 'u2', type: 'terms', version: 'v1' })
		const u1History = await service.history('u1')
		expect(u1History.length).toBe(1)
		expect(u1History.every((h) => h.userId === 'u1')).toBe(true)
	})
})
