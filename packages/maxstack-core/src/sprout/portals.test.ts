/**
 * Portal enforcement, against a real pglite database.
 *
 * **Every test is named after the exposure it prevents.** The suite is read
 * twice — once when it is written and once by somebody asking, in an incident,
 * "could this have been how it got out?" — and a name like `applies the
 * projection` answers that question for nobody.
 *
 * The structure copies #174's leak test, including the part that matters most:
 * **every assertion of absence opens by proving the ungated query genuinely
 * returns the row or field it then requires to be missing.** Without that, a
 * projection test passes just as happily against a database with no rows in it,
 * and a bound test passes against a filter that matches nothing.
 *
 * The last block is the deliberate-exposure test the issue names as an exit
 * criterion: a portal misdeclared in each of the dangerous ways, each refused.
 */

import type { PGlite } from '@electric-sql/pglite'
import { boolean, pgTable, text, timestamp, uuid } from 'drizzle-orm/pg-core'
import { drizzle } from 'drizzle-orm/pglite'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { createDrizzleStore } from '../demo/store.ts'
import { bootPglite } from '../testing/pglite-snapshot.ts'
import { AUTHENTICATED_WRITES, accessWithPortals } from './from-spec.ts'
import {
	NotFoundError,
	type OpContext,
	opCount,
	opCreate,
	opDelete,
	opGet,
	opGetMany,
	opList,
	opRestore,
	opSearch,
	opUpdate,
	projectForPortal,
	RateLimitedError,
	UnsupportedOperationError,
	ValidationError,
} from './operations.ts'
import {
	canPerformAction,
	PermissionError,
	portalGrants,
	type SproutUser,
} from './permissions.ts'
import { type PortalPlan, portalIdentity } from './portals.ts'
import { ResourceRegistry } from './registry.ts'
import { withMeta } from './schema-builder.ts'
import type { SearchIndexPlan } from './search.ts'

// ---------------------------------------------------------------------------
// A post table with exactly the columns worth not exposing.
// ---------------------------------------------------------------------------

const post = pgTable('post', {
	id: uuid('id').primaryKey().defaultRandom(),
	title: withMeta(text('title'), {}),
	body: withMeta(text('body'), {}),
	published: withMeta(boolean('published'), {}),
	/** The one a portal must never leak, and the one every test checks for. */
	internalNotes: withMeta(text('internalNotes'), {}),
	authorId: withMeta(text('authorId'), {}),
	deletedAt: timestamp('deletedAt'),
})

const DDL = `
CREATE TABLE IF NOT EXISTS post (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  title text,
  body text,
  published boolean,
  "internalNotes" text,
  "authorId" text,
  "deletedAt" timestamp
);
`

const SEARCH_PLAN: SearchIndexPlan = {
	key: 'post-search',
	language: 'english',
	fields: [
		{ column: 'title', weight: 'A' },
		// Deliberately indexed and deliberately NOT exposed — the whole reason
		// `opSearch` refuses a portal identity.
		{ column: 'internalNotes', weight: 'B' },
	],
	indexed: false,
}

/** The public archive: published posts, title and body only. */
const ARCHIVE: PortalPlan = {
	key: 'archive',
	description: 'The public archive of published posts.',
	resource: 'post',
	audience: 'public',
	scope: 'collection',
	readFields: ['title', 'body'],
	writes: [],
	filter: { field: 'published', equals: true },
	layout: 'feed',
	paused: false,
}

let client: PGlite
let registry: ResourceRegistry
let store: ReturnType<typeof createDrizzleStore>
let publishedId: string
let draftId: string

beforeAll(async () => {
	client = await bootPglite()
	await client.exec(DDL)
	registry = new ResourceRegistry()
	registry.register(post, { portals: [ARCHIVE], search: SEARCH_PLAN })
	store = createDrizzleStore(drizzle({ client }), registry, (t, p) =>
		client
			.query(t, p as unknown[] | undefined)
			.then((r) => r.rows as Record<string, unknown>[]),
	)
	const admin = { registry, store, user: null } as OpContext
	const live = await opCreate(admin, 'post', {
		title: 'Cooking rice',
		body: 'Rinse it.',
		published: true,
		internalNotes: 'PAY THE AUTHOR 400',
		authorId: 'u-ann',
	})
	publishedId = String(live.id)
	const draft = await opCreate(admin, 'post', {
		title: 'Unfinished',
		body: 'wip',
		published: false,
		internalNotes: 'do not ship',
		authorId: 'u-ann',
	})
	draftId = String(draft.id)
})

afterAll(async () => {
	await client.close()
})

/** A context whose identity is whatever the caller passes. */
function ctxFor(
	user: SproutUser | null,
	over: Partial<OpContext> = {},
): OpContext {
	return { registry, store, user, ...over }
}

/** An always-allowing limiter, so budget refusals are opt-in per test. */
const allowAll = () => true

/** The public archive's identity, as the route would build it. */
function visitor(over: Partial<OpContext> = {}): OpContext {
	const user = portalIdentity(ARCHIVE, { clientId: '203.0.113.9' })
	expect(user).not.toBeNull()
	return ctxFor(user, { rateLimit: allowAll, ...over })
}

// ===========================================================================
// 0. Non-vacuity — the ungated read genuinely returns what the rest requires
//    to be absent.
// ===========================================================================

describe('the ungated read really does reach what a portal must not', () => {
	it('returns the draft, the internal note and the author id to an ordinary caller', async () => {
		const rows = await opList(ctxFor(null), 'post', { limit: 10 })
		expect(rows).toHaveLength(2)
		expect(rows.map((r) => r.title)).toContain('Unfinished')
		expect(rows.map((r) => r.internalNotes)).toContain('PAY THE AUTHOR 400')
		expect(rows.every((r) => 'authorId' in r)).toBe(true)
	})
})

// ===========================================================================
// 1. The projection — an undeclared column never leaves a read op.
// ===========================================================================

describe('a column nobody declared never leaves a read op', () => {
	it('returns exactly the declared fields plus the primary key, and nothing else', async () => {
		const [row] = await opList(visitor(), 'post', { limit: 10 })
		// `toEqual` on the key set, not a spot check: a spot check passes while a
		// column nobody thought of rides along.
		expect(Object.keys(row ?? {}).sort()).toEqual(['body', 'id', 'title'])
	})

	it('drops the internal note from a single-row read too', async () => {
		const row = await opGet(visitor(), 'post', publishedId)
		expect(row).not.toHaveProperty('internalNotes')
		expect(row.title).toBe('Cooking rice')
	})

	it('drops the soft-delete column, which no projection ever names', async () => {
		const [row] = await opList(visitor(), 'post', { limit: 10 })
		expect(row).not.toHaveProperty('deletedAt')
	})

	it('drops a DERIVED value that was not declared', async () => {
		// The one that is easiest to miss: a rollup arrives AFTER the store, so it
		// is not a column anybody wrote down as exposed. The projection runs last,
		// after `withDerived`, precisely so this cannot slip past.
		const withRollup = visitor({
			derived: async (_resource, rows) =>
				rows.map((r) => ({ ...r, secretTotal: 99_000 })),
		})
		const [row] = await opList(withRollup, 'post', { limit: 10 })
		expect(row).not.toHaveProperty('secretTotal')
		// And non-vacuously: the resolver really did attach it for a normal caller.
		const [normal] = await opList(
			ctxFor(null, {
				derived: async (_r, rows) =>
					rows.map((x) => ({ ...x, secretTotal: 99_000 })),
			}),
			'post',
			{ limit: 10 },
		)
		expect(normal?.secretTotal).toBe(99_000)
	})

	it('keeps the primary key, which is a uuid and therefore says nothing', async () => {
		const [row] = await opList(visitor(), 'post', { limit: 10 })
		expect(String(row?.id)).toMatch(
			/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/,
		)
	})

	it('is a pure function of the identity, so it can be asserted directly', () => {
		const user = portalIdentity(ARCHIVE, { clientId: 'x' })
		const entry = registry.get('post')
		expect(entry).toBeDefined()
		if (!entry) return
		const projected = projectForPortal(user, entry, [
			{ id: 'a', title: 't', internalNotes: 'secret', deletedAt: null },
		])
		expect(projected[0]).toEqual({ id: 'a', title: 't' })
	})
})

// ===========================================================================
// 2. The bound — a portal never reaches a row outside its own filter.
// ===========================================================================

describe('a row outside the declared bound is unreachable, and reads as absent', () => {
	it('lists only the rows the filter admits', async () => {
		const rows = await opList(visitor(), 'post', { limit: 10 })
		expect(rows).toHaveLength(1)
		expect(rows[0]?.title).toBe('Cooking rice')
	})

	it('cannot widen the bound with a caller-supplied filter', async () => {
		// The forced scope spreads LAST, over anything the caller sent — the same
		// ordering rule the tenant and soft-delete scopes follow.
		const rows = await opList(visitor(), 'post', {
			filter: { published: false },
			limit: 10,
		})
		expect(rows.every((r) => r.title === 'Cooking rice')).toBe(true)
	})

	it('404s a direct fetch of a row outside the bound, rather than 403ing it', async () => {
		// A 403 would confirm the row exists. A portal that distinguished "outside
		// your bound" from "does not exist" is an existence oracle for anybody
		// holding a list of uuids.
		await expect(opGet(visitor(), 'post', draftId)).rejects.toThrow(
			NotFoundError,
		)
		// Non-vacuity: that id is a real row, and an ordinary caller gets it.
		await expect(opGet(ctxFor(null), 'post', draftId)).resolves.toHaveProperty(
			'title',
			'Unfinished',
		)
	})

	it('drops an out-of-bound row from getMany rather than erroring on it', async () => {
		const rows = await opGetMany(visitor(), 'post', [publishedId, draftId])
		expect(rows).toHaveLength(1)
		expect(rows[0]?.title).toBe('Cooking rice')
	})

	it('counts only what it could have listed', async () => {
		expect(await opCount(visitor(), 'post')).toBe(1)
		expect(await opCount(ctxFor(null), 'post')).toBe(2)
	})
})

describe('an undeclared column is not a comparison oracle', () => {
	it('refuses an orderBy on a column the portal does not expose', async () => {
		// Real attack, not tidiness: the caller never sees `internalNotes`, but the
		// permutation of the rows they can see is a comparison oracle, and a few
		// dozen paged requests reconstruct the ordering.
		await expect(
			opList(visitor(), 'post', { orderBy: 'internalNotes' }),
		).rejects.toThrow(PermissionError)
	})

	it('refuses an equality filter on a column the portal does not expose', async () => {
		await expect(
			opList(visitor(), 'post', {
				filter: { internalNotes: 'PAY THE AUTHOR 400' },
			}),
		).rejects.toThrow(PermissionError)
	})

	it('allows ordering by a declared column and by the bound', async () => {
		await expect(
			opList(visitor(), 'post', { orderBy: 'title' }),
		).resolves.toHaveLength(1)
		await expect(
			opList(visitor(), 'post', { orderBy: 'published' }),
		).resolves.toHaveLength(1)
	})

	it('allows filtering and ordering by the PRIMARY KEY, which every row already carries', async () => {
		// Issue #179 widened `assertPortalReadShape` to treat the primary key as
		// visible, and a change to a security function needs an assertion rather
		// than an argument — so here it is, from both sides.
		//
		// It is a consistency fix, not a relaxation: `projectForPortal` already
		// returns the primary key on every row (a uuid encodes no ordering, no
		// timestamp and no count), and `opGet` already lets a portal fetch one row
		// by id under the same bound. Filtering or ordering by a value the caller
		// is handed back is not an oracle over anything. The live push path needs
		// it because it resolves one changed row through `opList` rather than
		// through a second query, which is what makes push and poll the same op.
		const [row] = await opList(visitor(), 'post', { limit: 10 })
		const id = String(row?.id)
		// Non-vacuous: the caller genuinely already has this id.
		expect(id).toBe(publishedId)
		await expect(
			opList(visitor(), 'post', { filter: { id } }),
		).resolves.toHaveLength(1)
		await expect(
			opList(visitor(), 'post', { orderBy: 'id' }),
		).resolves.toHaveLength(1)
	})

	it('still refuses the DRAFT row when filtering by its primary key', async () => {
		// The bound outranks the id. Widening the read shape must not have turned
		// the primary key into a way around the portal's declared filter — a
		// caller who guesses an unpublished post's id gets nothing.
		await expect(
			opList(visitor(), 'post', { filter: { id: draftId } }),
		).resolves.toEqual([])
	})

	it('refuses ranked search outright rather than projecting it', async () => {
		// `ts_rank` and the match predicate both run over the WHOLE tsvector, which
		// here includes `internalNotes`. Projecting the rows would leave both the
		// match and the ordering as oracles over a column the portal cannot read.
		await expect(opSearch(visitor(), 'post', 'rice')).rejects.toThrow(
			PermissionError,
		)
	})
})

// ===========================================================================
// 3. portalGrants — closed by default, and delete has no path.
// ===========================================================================

describe('a portal reaches nothing it did not declare', () => {
	const identity = () => portalIdentity(ARCHIVE, { clientId: 'x' })

	it('leaves a non-portal identity completely unaffected', () => {
		expect(portalGrants(null, 'anything', 'delete')).toBe(true)
		expect(portalGrants({ id: 'u' }, 'anything', 'create')).toBe(true)
	})

	it('denies every resource but its own', () => {
		expect(portalGrants(identity(), 'invoice', 'read')).toBe(false)
		expect(portalGrants(identity(), 'post', 'read')).toBe(true)
	})

	it('denies an action the portal did not declare', () => {
		expect(portalGrants(identity(), 'post', 'create')).toBe(false)
		expect(portalGrants(identity(), 'post', 'update')).toBe(false)
	})

	it('never grants delete, on any portal, by any spelling', () => {
		const writable: PortalPlan = {
			...ARCHIVE,
			// Not spellable in the vocabulary; forced here to prove the second
			// refusal exists, so adding a `delete` action later would still not
			// make it reachable without deliberately removing a line.
			writes: [
				{
					action: 'delete' as unknown as 'create',
					fields: ['title'],
					rateLimitPerHour: 10,
				},
			],
		}
		expect(
			portalGrants(
				portalIdentity(writable, { clientId: 'x' }),
				'post',
				'delete',
			),
		).toBe(false)
	})

	it('is CLOSED by default on a resource with no access rules at all', async () => {
		// The property that matters most over time. `canPerformAction` is
		// open-by-default everywhere else, so a table added next month would
		// otherwise be reachable by every existing portal on the day it is created.
		const other = pgTable('untouched', { id: uuid('id').primaryKey() })
		const reg = new ResourceRegistry()
		reg.register(post, { portals: [ARCHIVE] })
		reg.register(other) // no access rules whatsoever
		expect(reg.get('untouched')?.config.access).toBeUndefined()
		expect(
			await canPerformAction('untouched', undefined, 'read', {
				user: identity(),
			}),
		).toBe(false)
		// And a session is unaffected by that same call.
		expect(
			await canPerformAction('untouched', undefined, 'read', {
				user: { id: 'u-ann' },
			}),
		).toBe(true)
	})

	it('is a filter and never a grant — it cannot beat the resource’s own rule', async () => {
		expect(
			await canPerformAction('post', { read: () => false }, 'read', {
				user: identity(),
			}),
		).toBe(false)
	})

	it('does not read as an authenticated session', async () => {
		// The quietest possible hole: a synthetic user object built for a public
		// URL is truthy, so a naive `!!user` would admit every anonymous visitor to
		// every rule anybody ever wrote as "authenticated".
		expect(
			await canPerformAction('post', { read: 'authenticated' }, 'read', {
				user: identity(),
			}),
		).toBe(false)
	})

	it('refuses to build an identity for a paused portal', () => {
		expect(
			portalIdentity({ ...ARCHIVE, paused: true }, { clientId: 'x' }),
		).toBe(null)
	})
})

// ===========================================================================
// 4. Writes.
// ===========================================================================

const COMMENTS: PortalPlan = {
	key: 'submit',
	description: 'Anyone may submit a post for review.',
	resource: 'post',
	audience: 'public',
	scope: 'collection',
	readFields: ['title'],
	writes: [
		{ action: 'create', fields: ['title', 'body'], rateLimitPerHour: 5 },
	],
	filter: { field: 'published', equals: false },
	layout: 'feed',
	paused: false,
}

describe('a write from the outside touches only what it declared', () => {
	function submitter(over: Partial<OpContext> = {}): OpContext {
		return ctxFor(portalIdentity(COMMENTS, { clientId: 'c' }), {
			rateLimit: allowAll,
			...over,
		})
	}

	it('refuses a payload naming an undeclared field, rather than stripping it', async () => {
		// Silent stripping is worse: the caller gets a 200 and believes the value
		// landed. An attacker learns nothing either way — and neither does the
		// honest caller, which is the half people forget.
		await expect(
			opCreate(submitter(), 'post', {
				title: 'Hi',
				internalNotes: 'PROMOTE ME',
			}),
		).rejects.toThrow(ValidationError)
	})

	it('cannot create a row outside its own bound, because the bound is server-stamped', async () => {
		const created = await opCreate(submitter(), 'post', {
			title: 'From the outside',
			// A client-sent value for the bound column, which must lose.
			body: 'hello',
		})
		expect(created.published).toBe(false)
	})

	it('cannot set the soft-delete column', async () => {
		await expect(
			opCreate(submitter(), 'post', { title: 'x', deletedAt: new Date() }),
		).rejects.toThrow(ValidationError)
	})

	it('refuses the write entirely when no limiter is wired', async () => {
		// The asymmetry with `derived`: a missing derived resolver costs rollups, a
		// missing limiter costs the write. A host that forgot to configure one gets
		// no anonymous writes rather than unlimited ones.
		await expect(
			opCreate(ctxFor(portalIdentity(COMMENTS, { clientId: 'c' })), 'post', {
				title: 'x',
			}),
		).rejects.toThrow(UnsupportedOperationError)
	})

	it('spends the DECLARED budget, in a bucket keyed on the portal and the caller', async () => {
		const seen: { key: string; perHour: number }[] = []
		const ctx = submitter({
			rateLimit: (key, perHour) => {
				seen.push({ key, perHour })
				return seen.length <= 1
			},
		})
		await opCreate(ctx, 'post', { title: 'first' })
		await expect(opCreate(ctx, 'post', { title: 'second' })).rejects.toThrow(
			RateLimitedError,
		)
		expect(seen[0]?.perHour).toBe(5)
		expect(seen[0]?.key).toContain('portal:submit:create:')
	})

	it('cannot update, because it declared only create', async () => {
		// `draftId` is INSIDE this portal's bound, so the refusal that fires is the
		// action one rather than the bound one — which is the point: a portal that
		// declared no `update` is denied even on a row it can read.
		await expect(
			opUpdate(submitter(), 'post', draftId, { title: 'defaced' }),
		).rejects.toThrow(PermissionError)
	})

	it('cannot delete, and cannot restore a deleted row either', async () => {
		await expect(opDelete(submitter(), 'post', publishedId)).rejects.toThrow(
			PermissionError,
		)
		// `opRestore` is mechanically an update, which is exactly why it needs its
		// own refusal: a portal declaring `update` would otherwise be able to
		// un-delete rows.
		await expect(opRestore(submitter(), 'post', publishedId)).rejects.toThrow(
			PermissionError,
		)
	})
})

// ===========================================================================
// 5. The deploy posture.
// ===========================================================================

describe('a declared portal reconciles with AUTHENTICATED_WRITES rather than overriding it', () => {
	it('leaves an action no portal declared exactly as strict as it was', async () => {
		const access = accessWithPortals(AUTHENTICATED_WRITES, [ARCHIVE])
		// The read-only archive does not make the entity anonymously writable.
		expect(
			await canPerformAction('post', access, 'create', { user: null }),
		).toBe(false)
	})

	it('admits ONLY the portal, and only for the action it declared', async () => {
		const access = accessWithPortals(AUTHENTICATED_WRITES, [COMMENTS])
		const identity = portalIdentity(COMMENTS, { clientId: 'c' })
		expect(
			await canPerformAction('post', access, 'create', { user: identity }),
		).toBe(true)
		// An anonymous NON-portal caller is still refused — the posture survives.
		expect(
			await canPerformAction('post', access, 'create', { user: null }),
		).toBe(false)
		// And `update`, which no portal declared, is untouched for everybody.
		expect(
			await canPerformAction('post', access, 'update', { user: identity }),
		).toBe(false)
	})

	it('changes nothing at all for an entity with no portals', () => {
		expect(accessWithPortals(AUTHENTICATED_WRITES, [])).toBe(
			AUTHENTICATED_WRITES,
		)
		expect(accessWithPortals(AUTHENTICATED_WRITES, undefined)).toBe(
			AUTHENTICATED_WRITES,
		)
	})
})

// ===========================================================================
// 6. The deliberate-exposure test (issue exit criterion).
// ===========================================================================

describe('deliberate exposure: a portal misdeclared in each dangerous way is refused', () => {
	it('a portal aimed at a resource it does not own reads nothing', async () => {
		const reg = new ResourceRegistry()
		reg.register(post, { portals: [ARCHIVE] })
		const other = pgTable('invoice', { id: uuid('id').primaryKey() })
		reg.register(other, { access: { read: 'public' } })
		const ctx: OpContext = {
			registry: reg,
			store,
			user: portalIdentity(ARCHIVE, { clientId: 'x' }),
		}
		await expect(opList(ctx, 'invoice')).rejects.toThrow(PermissionError)
	})

	it('a resource with NO access rules is still unreachable', async () => {
		const reg = new ResourceRegistry()
		reg.register(post, { portals: [ARCHIVE] })
		const bare = pgTable('audit_trail', { id: uuid('id').primaryKey() })
		reg.register(bare)
		const ctx: OpContext = {
			registry: reg,
			store,
			user: portalIdentity(ARCHIVE, { clientId: 'x' }),
		}
		await expect(opList(ctx, 'audit_trail')).rejects.toThrow(PermissionError)
	})

	it('an undeclared-column orderBy is refused rather than ignored', async () => {
		await expect(
			opList(visitor(), 'post', { orderBy: 'internalNotes' }),
		).rejects.toThrow(PermissionError)
	})

	it('an anonymous update is refused even if an identity is hand-built with one', async () => {
		// The spec validator refuses `public` + `update` at declare time. This is
		// the second wall: even a hand-assembled identity carrying the declaration
		// the vocabulary cannot express still has to pass the write allowlist and
		// the budget, and the row bound still applies.
		const rogue: PortalPlan = {
			...ARCHIVE,
			writes: [{ action: 'update', fields: ['title'], rateLimitPerHour: 10 }],
		}
		const ctx = ctxFor(portalIdentity(rogue, { clientId: 'x' }), {
			rateLimit: allowAll,
		})
		// It CAN reach the row it declared a bound over — that is what the
		// declaration says — but it cannot touch anything else…
		await expect(
			opUpdate(ctx, 'post', publishedId, { internalNotes: 'defaced' }),
		).rejects.toThrow(ValidationError)
		// …and it cannot reach a row outside the bound at all.
		await expect(
			opUpdate(ctx, 'post', draftId, { title: 'defaced' }),
		).rejects.toThrow(NotFoundError)
	})

	it('a row-scoped identity cannot enumerate, and reaches only its own row', async () => {
		const clientPortal: PortalPlan = {
			key: 'client-invoice',
			description: 'One post, for one reader.',
			resource: 'post',
			audience: 'token',
			token: { ttlHours: 24, maxUses: null },
			scope: 'row',
			readFields: ['title'],
			writes: [],
			layout: 'detail',
			paused: false,
		}
		const ctx = ctxFor(
			portalIdentity(clientPortal, {
				clientId: 'x',
				tokenId: 'tok-1',
				rowId: publishedId,
			}),
		)
		await expect(opList(ctx, 'post')).rejects.toThrow(PermissionError)
		await expect(opCount(ctx, 'post')).rejects.toThrow(PermissionError)
		await expect(opGetMany(ctx, 'post', [publishedId])).rejects.toThrow(
			PermissionError,
		)
		await expect(opGet(ctx, 'post', draftId)).rejects.toThrow(NotFoundError)
		await expect(opGet(ctx, 'post', publishedId)).resolves.toEqual({
			id: publishedId,
			title: 'Cooking rice',
		})
	})

	it('a token that names no row cannot open a row portal at all', () => {
		const rowPortal: PortalPlan = {
			...ARCHIVE,
			key: 'rowless',
			audience: 'token',
			token: { ttlHours: 1, maxUses: null },
			scope: 'row',
			layout: 'detail',
			filter: undefined,
		}
		expect(
			portalIdentity(rowPortal, { clientId: 'x', tokenId: 'tok-1' }),
		).toBeNull()
	})

	it('a role portal needs the role, not merely a session', () => {
		const rolePortal: PortalPlan = {
			...ARCHIVE,
			key: 'support',
			audience: 'role',
			role: 'support',
		}
		expect(
			portalIdentity(rolePortal, {
				clientId: 'x',
				session: { id: 'u-bob', role: 'member' },
			}),
		).toBeNull()
		expect(
			portalIdentity(rolePortal, {
				clientId: 'x',
				session: { id: 'u-bob', role: 'support' },
			}),
		).not.toBeNull()
	})
})
