/**
 * `ConsentService` — records terms-of-service and cookie-consent acceptance,
 * versioned. Deliberately append-only (see schema.ts): `record`
 * always inserts, `latest` reads back the most recent row per type, `hasAccepted`
 * answers "did this user accept version X" for gating a re-prompt.
 */

import { and, desc, eq } from 'drizzle-orm'
import type { drizzle } from 'drizzle-orm/pglite'
import { type ConsentType, consent } from './schema.ts'

type Db = ReturnType<typeof drizzle>

export interface ConsentRecord {
	id: number
	userId: string
	type: ConsentType
	version: string
	acceptedAt: Date
}

export interface RecordConsentInput {
	userId: string
	type: ConsentType
	version: string
}

export class ConsentService {
	private readonly db: Db

	constructor(opts: { db: Db }) {
		this.db = opts.db
	}

	/** Record an acceptance. Always inserts a new row — see schema.ts for why. */
	async record(input: RecordConsentInput): Promise<ConsentRecord> {
		const [row] = await this.db
			.insert(consent)
			.values({
				userId: input.userId,
				type: input.type,
				version: input.version,
			})
			.returning()
		if (!row) throw new Error('Failed to record consent')
		return row as ConsentRecord
	}

	/** The most recent acceptance of `type` for `userId`, or `null` if they've
	 * never accepted it. */
	async latest(
		userId: string,
		type: ConsentType,
	): Promise<ConsentRecord | null> {
		const rows = await this.db
			.select()
			.from(consent)
			.where(and(eq(consent.userId, userId), eq(consent.type, type)))
			// `acceptedAt` alone is not a total order: `now()` is fixed for a
			// transaction and the column has no sub-tick guarantee, so two
			// acceptances landing in the same tick tie and the winner is whatever
			// the plan happens to emit. That is not hypothetical — a double-clicked
			// accept, or a version bump accepted right after a first acceptance,
			// and `latest`/`hasAccepted` can answer with the *older* version, which
			// is the gate deciding whether to re-prompt. `id` is a serial on an
			// append-only table, so it breaks the tie exactly.
			.orderBy(desc(consent.acceptedAt), desc(consent.id))
			.limit(1)
		return (rows[0] as ConsentRecord) ?? null
	}

	/** Has `userId` accepted `type` at `version` (or later — string-equal only;
	 * callers compare their own version scheme for "later"). */
	async hasAccepted(
		userId: string,
		type: ConsentType,
		version: string,
	): Promise<boolean> {
		const row = await this.latest(userId, type)
		return row?.version === version
	}

	/** Full acceptance history for `userId` (both types), most-recent first —
	 * what the GDPR export folds in as the user's consent record. */
	async history(userId: string): Promise<ConsentRecord[]> {
		const rows = await this.db
			.select()
			.from(consent)
			.where(eq(consent.userId, userId))
			// Same tiebreaker as `latest`, so an export lists a same-tick pair in
			// the order they were actually recorded rather than an arbitrary one.
			.orderBy(desc(consent.acceptedAt), desc(consent.id))
		return rows as ConsentRecord[]
	}
}
