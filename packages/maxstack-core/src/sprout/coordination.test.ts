/**
 * Issue #228 (absorbing #227's first half): the shared coordination store.
 *
 * The in-process suite runs everywhere. The shared suite runs only when
 * `MAXSTACK_TEST_POSTGRES_URL` points at a throwaway database, matching
 * `backend.test.ts` — and unlike the store contract, whose pglite run is the
 * standing proof and whose Postgres run is a parity confirmation, **the shared
 * coordinator has no standing proof without it**. That is stated here and in
 * `docs/live.md` rather than left for somebody to discover: the thing this issue
 * built is the Postgres path, so a run without that variable has not tested the
 * fix, only the shape around it.
 */

import { afterEach, describe, expect, it } from 'vitest'
import { createBackend, type StoreBackend } from './backend.ts'
import {
	COORDINATION_DDL,
	COORDINATOR_MAX_PAYLOAD_BYTES,
	type Coordinator,
	createInProcessCoordinator,
	createPostgresCoordinator,
	spendToken,
	type TokenRequest,
} from './coordination.ts'

/** A budget sequence with every interesting shape in it: a drain, a refusal, a
 * partial refill, a budget raised mid-flight, and a second key that must be
 * untouched by any of it. Shared by the arithmetic test and the SQL agreement
 * test, so the two are demonstrably answering the same questions. */
const SEQUENCE: TokenRequest[] = [
	{ key: 'a', max: 3, windowMs: 1000, now: 0 },
	{ key: 'a', max: 3, windowMs: 1000, now: 0 },
	{ key: 'b', max: 3, windowMs: 1000, now: 0 },
	{ key: 'a', max: 3, windowMs: 1000, now: 0 },
	{ key: 'a', max: 3, windowMs: 1000, now: 0 },
	{ key: 'a', max: 3, windowMs: 1000, now: 200 },
	{ key: 'a', max: 3, windowMs: 1000, now: 400 },
	// The budget is raised while the bucket is drained. Headroom, not
	// amnesty.
	{ key: 'a', max: 10, windowMs: 1000, now: 400 },
	{ key: 'a', max: 10, windowMs: 1000, now: 900 },
	{ key: 'b', max: 3, windowMs: 1000, now: 900 },
]

describe('the in-process coordinator (the single-instance default)', () => {
	it('delivers an announcement to this process, synchronously', async () => {
		const coordinator = createInProcessCoordinator()
		const heard: string[] = []
		coordinator.listen((m) => heard.push(`${m.topic}:${m.payload}`))
		await coordinator.announce({ topic: 'live.change', payload: '{"id":"1"}' })
		expect(heard).toEqual(['live.change:{"id":"1"}'])
	})

	it('stops delivering once a listener unsubscribes', async () => {
		const coordinator = createInProcessCoordinator()
		const heard: string[] = []
		const off = coordinator.listen((m) => heard.push(m.payload))
		await coordinator.announce({ topic: 't', payload: 'one' })
		off()
		await coordinator.announce({ topic: 't', payload: 'two' })
		expect(heard).toEqual(['one'])
	})

	/** The ceiling is enforced on the in-process path too, or a payload that
	 * passed every test would fail on the deployment shape this exists for. */
	it('refuses a payload larger than a NOTIFY can carry', async () => {
		const coordinator = createInProcessCoordinator()
		await expect(
			coordinator.announce({
				topic: 'live.change',
				payload: 'x'.repeat(COORDINATOR_MAX_PAYLOAD_BYTES + 1),
			}),
		).rejects.toThrow(/over the \d+-byte limit/)
	})

	it('measures the payload in bytes, not characters', async () => {
		const coordinator = createInProcessCoordinator()
		// Three bytes per character in UTF-8: a length check would have passed this.
		await expect(
			coordinator.announce({
				topic: 'live.change',
				payload: '株'.repeat(COORDINATOR_MAX_PAYLOAD_BYTES / 3 + 1),
			}),
		).rejects.toThrow(/over the \d+-byte limit/)
	})

	it('spends tokens exactly as the arithmetic says', async () => {
		const coordinator = createInProcessCoordinator()
		const got = []
		for (const request of SEQUENCE) got.push(await coordinator.take(request))
		expect(got.map((v) => v.allowed)).toEqual(
			replay(SEQUENCE).map((v) => v.allowed),
		)
		expect(got.map((v) => v.limit)).toEqual(
			replay(SEQUENCE).map((v) => v.limit),
		)
	})

	it('refuses a bucket with no capacity rather than treating it as unlimited', async () => {
		const coordinator = createInProcessCoordinator()
		const verdict = await coordinator.take({
			key: 'k',
			max: 0,
			windowMs: 1000,
			now: 0,
		})
		expect(verdict.allowed).toBe(false)
	})
})

/**
 * The bound this issue exists to remove, asserted as it stands today: two
 * in-process coordinators are two instances, and they serve a 3/window budget
 * six times between them.
 *
 * A test of the *defect* rather than of the fix, and it earns its place — it is
 * the thing that makes the shared assertion below mean something, and it fails
 * loudly if somebody ever makes the in-process coordinator quietly global.
 */
describe('the multiplication, demonstrated', () => {
	it('two in-process coordinators serve a budget twice over', async () => {
		const a = createInProcessCoordinator()
		const b = createInProcessCoordinator()
		let allowed = 0
		for (const coordinator of [a, b])
			for (let i = 0; i < 4; i++)
				if (
					(await coordinator.take({ key: 'p', max: 3, windowMs: 1000, now: 0 }))
						.allowed
				)
					allowed += 1
		expect(allowed).toBe(6)
	})
})

/** Drive {@link spendToken} over a sequence, the way a coordinator does. */
function replay(sequence: TokenRequest[]) {
	const buckets = new Map<
		string,
		{ tokens: number; updatedAt: number; max: number }
	>()
	return sequence.map((request) => {
		const { verdict, next } = spendToken(buckets.get(request.key), request)
		buckets.set(request.key, next)
		return verdict
	})
}

const pgUrl = process.env.MAXSTACK_TEST_POSTGRES_URL?.trim()

/**
 * ## How this suite is guaranteed to actually run in CI
 *
 * Not by anything in this file, and the first two attempts both got that wrong.
 *
 * Attempt one added a Postgres service and a step asserting the port was open.
 * It passed while every test here skipped: `turbo.json` declares
 * `globalPassThroughEnv`, which puts turbo in strict env mode, so
 * `MAXSTACK_TEST_POSTGRES_URL` was stripped before vitest saw it. Attempt two
 * asserted from inside the suite that the URL must be present whenever `CI` is
 * set — which is false, because most CI jobs run tests with no database at all,
 * and it reddened one of them.
 *
 * The guarantee is a **dedicated CI step that runs this file directly through
 * vitest**, outside turbo, with the URL set. It is a positive check — these
 * tests ran, here, and passed — rather than an inference from something else
 * being true, and no turbo configuration can quietly undo it. `pnpm validate`
 * runs them too (the `test` task declares the variable in its `env`), so in
 * practice they execute twice; that is a few seconds against a class of failure
 * that stayed invisible for the life of two test files.
 */
describe.skipIf(!pgUrl)('the shared coordinator, over Postgres', () => {
	const opened: { coordinators: Coordinator[]; backends: StoreBackend[] } = {
		coordinators: [],
		backends: [],
	}
	afterEach(async () => {
		for (const c of opened.coordinators.splice(0)) await c.dispose()
		for (const b of opened.backends.splice(0)) await b.dispose()
	})

	/** A coordinator over its own connection — one simulated instance. */
	async function instance(): Promise<Coordinator> {
		const backend = await createBackend({
			kind: 'postgres',
			url: pgUrl as string,
		})
		opened.backends.push(backend)
		const coordinator = await createPostgresCoordinator(backend)
		opened.coordinators.push(coordinator)
		return coordinator
	}

	/** Buckets persist in a table, so a test that reused a key would inherit the
	 * previous run's fill level. Every test names its own. */
	function freshKey(name: string): string {
		return `test:${name}:${process.pid}:${counter++}`
	}
	let counter = 0

	it('delivers an announcement from one instance to another', async () => {
		const a = await instance()
		const b = await instance()
		const heard: string[] = []
		b.listen((m) => heard.push(`${m.topic}:${m.payload}`))
		await a.announce({ topic: 'live.change', payload: '{"id":"1"}' })
		await waitFor(() => heard.length > 0)
		expect(heard).toEqual(['live.change:{"id":"1"}'])
	})

	/** The announcing instance hears its own announcement, which is what lets the
	 * host keep exactly one path from "a row changed" to "a socket got a frame".
	 * Without this, `live.server.ts` would need a local shortcut beside the
	 * listener — a second path that only runs in single-instance deploys. */
	it('delivers an announcement back to the instance that made it', async () => {
		const a = await instance()
		const heard: string[] = []
		a.listen((m) => heard.push(m.payload))
		await a.announce({ topic: 'live.change', payload: 'self' })
		await waitFor(() => heard.length > 0)
		expect(heard).toEqual(['self'])
	})

	/** The fix, stated as the inverse of the demonstration above: the same two
	 * instances, one budget. */
	it('two instances share one budget instead of multiplying it', async () => {
		const a = await instance()
		const b = await instance()
		const key = freshKey('shared-budget')
		let allowed = 0
		for (const coordinator of [a, b])
			for (let i = 0; i < 4; i++)
				if (
					(
						await coordinator.take({
							key,
							max: 3,
							windowMs: 60_000,
							now: 1_000,
						})
					).allowed
				)
					allowed += 1
		expect(allowed).toBe(3)
	})

	/**
	 * The SQL and {@link spendToken} agree, verdict for verdict, over a sequence
	 * containing every interesting shape.
	 *
	 * This is the test that makes the SQL transcription safe to have written: two
	 * token buckets that drift apart is how a deployment gets a different budget
	 * than its tests measured, and the drift would only show up under the
	 * backend that has no other coverage.
	 */
	it('agrees with the arithmetic, verdict for verdict', async () => {
		const coordinator = await instance()
		const suffix = freshKey('agreement')
		const scoped = SEQUENCE.map((r) => ({ ...r, key: `${suffix}:${r.key}` }))
		const fromSql = []
		for (const request of scoped) fromSql.push(await coordinator.take(request))
		const fromJs = replay(scoped)
		expect(fromSql.map((v) => v.allowed)).toEqual(fromJs.map((v) => v.allowed))
		expect(fromSql.map((v) => v.remaining)).toEqual(
			fromJs.map((v) => v.remaining),
		)
		expect(fromSql.map((v) => v.limit)).toEqual(fromJs.map((v) => v.limit))
	})

	it('refuses to build over a backend that cannot LISTEN', async () => {
		const pglite = await createBackend({ kind: 'pglite' })
		opened.backends.push(pglite)
		await expect(createPostgresCoordinator(pglite)).rejects.toThrow(
			/cannot LISTEN/,
		)
	})

	it('creates its table idempotently', async () => {
		const backend = await createBackend({
			kind: 'postgres',
			url: pgUrl as string,
		})
		opened.backends.push(backend)
		await backend.exec(COORDINATION_DDL)
		await backend.exec(COORDINATION_DDL)
		const rows = await backend.query(
			'SELECT count(*)::int AS n FROM maxstack_rate_bucket',
		)
		expect(typeof rows[0]?.n).toBe('number')
	})
})

/** `NOTIFY` arrives on another connection, so there is nothing to await. Poll
 * rather than sleep a fixed amount: a fixed sleep is either flaky or slow, and
 * on a loaded CI box it manages both. */
async function waitFor(
	predicate: () => boolean,
	timeoutMs = 5000,
): Promise<void> {
	const deadline = Date.now() + timeoutMs
	while (!predicate()) {
		if (Date.now() > deadline)
			throw new Error('timed out waiting for an announcement to arrive')
		await new Promise((resolve) => setTimeout(resolve, 10))
	}
}
