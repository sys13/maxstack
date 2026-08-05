/**
 * Declared portals at the spec layer: the five ops, the validator,
 * the selectors and the exposure report.
 *
 * **Every test is named after the exposure it prevents, not after the rule it
 * checks.** That is not a style preference. A validator for a public surface is
 * read twice — once when it is written, and once by somebody in an incident
 * asking "could this have been how it got out?" — and a suite whose test names
 * are `refuses an invalid audience` answers that question for nobody.
 *
 * The refusals are the whole content of this layer. Everything it lets through
 * becomes readable by somebody who has never signed in.
 */

import { describe, expect, it } from 'vitest'
import { tasklyPRD } from '../fixtures/index.ts'
import {
	activePortals,
	describePortal,
	findPortal,
	listPortals,
	MAX_PORTAL_FIELDS,
	MAX_PORTAL_TOKEN_TTL_HOURS,
	MAX_PUBLIC_WRITE_RATE,
	type PortalSpec,
	portalExposureReport,
	portalsFor,
	summarizeExposure,
} from './portals.ts'
import { manual, suggested } from './provenance.ts'
import {
	type ApplyMeta,
	applyOp,
	diffOp,
	SPEC_OP_NAMES,
	type SpecOp,
	validateOp,
} from './spec-ops.ts'
import { collectSpecSystemErrors } from './spec-system.schema.ts'
import { newSpecSystem, type SpecSystem } from './spec-system.ts'

const meta = (n: number): ApplyMeta => ({
	actor: { surface: 'harness' },
	id: `op-${n}`,
	origin: 'human',
	appliedAt: '2026-07-29',
})

/**
 * A spec with a post entity carrying one of every field type worth refusing —
 * including the two a public surface must never see: a `file` column (a storage
 * key) and a reference to `e-user` (an identity-table primary key).
 */
function withPost(): SpecSystem {
	return applyOp(
		newSpecSystem(tasklyPRD),
		{
			op: 'data.addEntity',
			args: {
				entity: {
					id: 'e-post',
					name: 'Post',
					description: 'A piece of writing.',
					fields: [
						{ id: 'fld-title', name: 'title', type: 'string', required: true },
						{ id: 'fld-body', name: 'body', type: 'string', required: false },
						{
							id: 'fld-published',
							name: 'published',
							type: 'boolean',
							required: false,
						},
						{ id: 'fld-views', name: 'views', type: 'number', required: false },
						{ id: 'fld-at', name: 'at', type: 'date', required: false },
						{ id: 'fld-meta', name: 'meta', type: 'json', required: false },
						{
							id: 'fld-notes',
							name: 'internalNotes',
							type: 'string',
							required: false,
						},
						{
							id: 'fld-author',
							name: 'authorId',
							type: 'string',
							required: false,
							reference: 'e-user',
						},
						{
							id: 'fld-hero',
							name: 'hero',
							type: 'file',
							required: false,
							file: { accept: ['image/png'], maxSizeBytes: 1024 },
						},
					],
				},
			},
		} as SpecOp,
		meta(1),
	)
}

/** A valid public, collection-scoped archive over the post entity. */
function portal(over: Partial<PortalSpec> = {}): PortalSpec {
	return {
		id: 'ptl-archive',
		key: 'archive',
		description: 'The public archive of published posts.',
		entityId: 'e-post',
		audience: 'public',
		scope: 'collection',
		readFields: ['fld-title', 'fld-body'],
		filter: { fieldId: 'fld-published', equals: true },
		writes: [],
		layout: 'feed',
		paused: false,
		declaredAt: '2026-07-29',
		provenance: manual(),
		...over,
	} as PortalSpec
}

const declare = (spec: PortalSpec): SpecOp => ({
	op: 'portals.declare',
	args: { portal: spec },
})

/** Declare a portal on a fresh post spec and return the resulting system. */
function declared(over: Partial<PortalSpec> = {}): SpecSystem {
	return applyOp(withPost(), declare(portal(over)), meta(2))
}

/** Everything wrong with declaring this portal on a fresh post spec. */
function errorsFor(over: Partial<PortalSpec> = {}): string[] {
	return validateOp(withPost(), declare(portal(over)))
}

// ===========================================================================

describe('the portal ops exist and are one family', () => {
	it('registers all five ops in the vocabulary', () => {
		for (const name of [
			'portals.declare',
			'portals.setFields',
			'portals.setWrites',
			'portals.pause',
			'portals.remove',
		])
			expect(SPEC_OP_NAMES).toContain(name)
	})

	it('a valid public archive declares cleanly and lands in the layer', () => {
		const spec = declared()
		expect(errorsFor()).toEqual([])
		expect(listPortals(spec)).toHaveLength(1)
		expect(findPortal(spec, 'archive')?.id).toBe('ptl-archive')
		expect(portalsFor(spec, 'e-post')).toHaveLength(1)
		expect(collectSpecSystemErrors(spec)).toEqual([])
	})
})

// ---------------------------------------------------------------------------
// The exposures this layer exists to prevent.
// ---------------------------------------------------------------------------

describe('a field nobody declared can never be read from the outside', () => {
	it('refuses a portal that names no fields, because there is no "expose everything"', () => {
		const errors = errorsFor({ readFields: [] })
		expect(errors.join('\n')).toMatch(/at least one field/)
		// The message has to say WHY there is no "all", or the next author looks
		// for the spelling rather than writing the list.
		expect(errors.join('\n')).toMatch(/all except/)
	})

	it('refuses a projection wider than the report a human reads', () => {
		const many = Array.from(
			{ length: MAX_PORTAL_FIELDS + 1 },
			(_, i) => `fld-x${i}`,
		) as PortalSpec['readFields']
		expect(errorsFor({ readFields: many }).join('\n')).toMatch(
			/exceeds the maximum/,
		)
	})

	it('refuses a field id that belongs to ANOTHER entity, which would resolve', () => {
		// The trap: an id from a sibling entity is a well-formed field id, so a
		// membership check against "all fields everywhere" would pass it and the
		// portal would project somebody else's column.
		const spec = applyOp(
			withPost(),
			{
				op: 'data.addEntity',
				args: {
					entity: {
						id: 'e-secret',
						name: 'Secret',
						fields: [
							{ id: 'fld-key', name: 'key', type: 'string', required: true },
						],
					},
				},
			} as SpecOp,
			meta(9),
		)
		const errors = validateOp(
			spec,
			declare(portal({ readFields: ['fld-key'] })),
		)
		expect(errors.join('\n')).toMatch(/not a field of entity "e-post"/)
	})

	it('refuses the same field twice, so the report cannot double-count', () => {
		expect(
			errorsFor({ readFields: ['fld-title', 'fld-title'] }).join('\n'),
		).toMatch(/twice/)
	})
})

describe('a storage key is never handed to the internet', () => {
	it('refuses a file field on a public portal', () => {
		expect(errorsFor({ readFields: ['fld-hero'] }).join('\n')).toMatch(
			/STORAGE KEY/,
		)
	})

	it('refuses a file field on a token portal too — a link is not a login', () => {
		const errors = errorsFor({
			readFields: ['fld-hero'],
			audience: 'token',
			token: { ttlHours: 24, maxUses: null },
		})
		expect(errors.join('\n')).toMatch(/STORAGE KEY/)
	})

	it('allows a file field on a ROLE portal, which is an ordinary session', () => {
		expect(
			errorsFor({
				readFields: ['fld-hero'],
				audience: 'role',
				role: 'support',
			}),
		).toEqual([])
	})
})

describe('the account list is never enumerable through a portal', () => {
	it('refuses a reference to e-user on a public portal', () => {
		expect(errorsFor({ readFields: ['fld-author'] }).join('\n')).toMatch(
			/enumerate the people who have accounts/,
		)
	})

	it('refuses one in a write allowlist as well as in the projection', () => {
		expect(
			errorsFor({
				writes: [
					{ action: 'create', fieldIds: ['fld-author'], rateLimitPerHour: 60 },
				],
			}).join('\n'),
		).toMatch(/enumerate the people who have accounts/)
	})
})

describe('anonymous editing of an existing row is unspellable', () => {
	it('refuses update on a public portal', () => {
		const errors = errorsFor({
			writes: [
				{ action: 'update', fieldIds: ['fld-title'], rateLimitPerHour: 10 },
			],
		})
		expect(errors.join('\n')).toMatch(/may not declare "update"/)
		// And it names the thing to do instead, or the next author reaches for the
		// nearest spelling that is accepted.
		expect(errors.join('\n')).toMatch(/audience "token"/)
	})

	it('allows update on a token portal, where the holder has a link only they were sent', () => {
		expect(
			errorsFor({
				audience: 'token',
				token: { ttlHours: 72, maxUses: 20 },
				scope: 'row',
				layout: 'detail',
				filter: undefined,
				writes: [
					{ action: 'update', fieldIds: ['fld-title'], rateLimitPerHour: 30 },
				],
			}),
		).toEqual([])
	})

	it('has no "delete" action at all — not a declaration, not a spelling', () => {
		const errors = errorsFor({
			writes: [
				{
					action: 'delete',
					fieldIds: ['fld-title'],
					rateLimitPerHour: 10,
				} as unknown as PortalSpec['writes'][number],
			],
		})
		expect(errors.join('\n')).toMatch(/is not one of create, update/)
		expect(errors.join('\n')).toMatch(/no path/)
	})
})

describe('a collection portal is never unbounded', () => {
	it('refuses a collection portal with no filter', () => {
		expect(errorsFor({ filter: undefined }).join('\n')).toMatch(
			/requires a filter/,
		)
	})

	it('refuses a bound whose value type does not match the column', () => {
		expect(
			errorsFor({
				filter: { fieldId: 'fld-published', equals: 'yes' },
			}).join('\n'),
		).toMatch(/but "published" is a boolean/)
	})

	it('refuses a bound on a date or json column, which bounds nothing legible', () => {
		expect(
			errorsFor({ filter: { fieldId: 'fld-at', equals: 'x' } }).join('\n'),
		).toMatch(/a bound has to be an equality somebody can read/)
		expect(
			errorsFor({ filter: { fieldId: 'fld-meta', equals: 'x' } }).join('\n'),
		).toMatch(/a bound has to be an equality somebody can read/)
	})

	it('refuses a write that names the bound column, which would write a row out of its own filter', () => {
		expect(
			errorsFor({
				writes: [
					{
						action: 'create',
						fieldIds: ['fld-title', 'fld-published'],
						rateLimitPerHour: 60,
					},
				],
			}).join('\n'),
		).toMatch(/write a row out of its own filter/)
	})
})

describe('one row is named by a credential, never by a guessable URL', () => {
	it('refuses a public row portal, where the row id would be the credential', () => {
		const errors = errorsFor({
			scope: 'row',
			layout: 'detail',
			filter: undefined,
		})
		expect(errors.join('\n')).toMatch(/scope "row" requires audience "token"/)
		expect(errors.join('\n')).toMatch(/can never be revoked/)
	})

	it('refuses a filter on a row portal — the token already names the row', () => {
		expect(
			errorsFor({
				scope: 'row',
				layout: 'detail',
				audience: 'token',
				token: { ttlHours: 24, maxUses: null },
			}).join('\n'),
		).toMatch(/filter is refused for scope "row"/)
	})

	it('refuses create on a row portal, which reaches a row that does not exist yet', () => {
		expect(
			errorsFor({
				scope: 'row',
				layout: 'detail',
				audience: 'token',
				token: { ttlHours: 24, maxUses: null },
				filter: undefined,
				writes: [
					{ action: 'create', fieldIds: ['fld-title'], rateLimitPerHour: 10 },
				],
			}).join('\n'),
		).toMatch(/may not declare "create"/)
	})
})

describe('a portal token always expires', () => {
	it('refuses a token audience with no policy at all', () => {
		const errors = errorsFor({ audience: 'token' })
		expect(errors.join('\n')).toMatch(/no non-expiring portal token/)
	})

	it('refuses a ttl beyond a year', () => {
		expect(
			errorsFor({
				audience: 'token',
				token: { ttlHours: MAX_PORTAL_TOKEN_TTL_HOURS + 1, maxUses: null },
			}).join('\n'),
		).toMatch(/ttlHours must be an integer/)
	})

	it('refuses an omitted maxUses — unlimited is a decision, absence is not', () => {
		expect(
			errorsFor({
				audience: 'token',
				token: { ttlHours: 24 } as unknown as PortalSpec['token'],
			}).join('\n'),
		).toMatch(/maxUses is required/)
	})

	it('refuses a token policy on a portal nothing checks it for', () => {
		expect(
			errorsFor({ token: { ttlHours: 24, maxUses: null } }).join('\n'),
		).toMatch(/only legal on audience "token"/)
	})

	it('refuses an unnamed role, which would grant to every session', () => {
		expect(errorsFor({ audience: 'role' }).join('\n')).toMatch(
			/requires a role name/,
		)
	})
})

describe('a write from the outside is always budgeted', () => {
	it('refuses a write with no hourly budget', () => {
		expect(
			errorsFor({
				writes: [
					{
						action: 'create',
						fieldIds: ['fld-title'],
					} as unknown as PortalSpec['writes'][number],
				],
			}).join('\n'),
		).toMatch(/needs an integer rateLimitPerHour/)
	})

	it('refuses an unauthenticated write budgeted past the public ceiling', () => {
		expect(
			errorsFor({
				writes: [
					{
						action: 'create',
						fieldIds: ['fld-title'],
						rateLimitPerHour: MAX_PUBLIC_WRITE_RATE + 1,
					},
				],
			}).join('\n'),
		).toMatch(/unbounded row generator/)
	})

	it('accepts an anonymous create inside the ceiling — a comment form is real', () => {
		expect(
			errorsFor({
				writes: [
					{ action: 'create', fieldIds: ['fld-title'], rateLimitPerHour: 60 },
				],
			}),
		).toEqual([])
	})

	it('refuses two writes for one action, where one would silently win', () => {
		expect(
			errorsFor({
				writes: [
					{ action: 'create', fieldIds: ['fld-title'], rateLimitPerHour: 10 },
					{ action: 'create', fieldIds: ['fld-body'], rateLimitPerHour: 10 },
				],
			}).join('\n'),
		).toMatch(/two "create" writes/)
	})
})

describe('the layout can never change what is exposed', () => {
	it('refuses a detail layout over a collection, which hides every row but one', () => {
		expect(errorsFor({ layout: 'detail' }).join('\n')).toMatch(
			/silently hides the rest/,
		)
	})

	it('refuses a list layout on a row portal', () => {
		expect(
			errorsFor({
				scope: 'row',
				audience: 'token',
				token: { ttlHours: 24, maxUses: null },
				filter: undefined,
				layout: 'table',
			}).join('\n'),
		).toMatch(/requires layout "detail"/)
	})
})

describe('two portals cannot share a URL', () => {
	it('refuses a duplicate key', () => {
		const spec = declared()
		expect(
			validateOp(spec, declare(portal({ id: 'ptl-two' }))).join('\n'),
		).toMatch(/already exists/)
	})

	it('allows several portals on one entity — two outsides on one table', () => {
		const spec = declared()
		const second = validateOp(
			spec,
			declare(
				portal({
					id: 'ptl-client',
					key: 'client',
					audience: 'token',
					token: { ttlHours: 48, maxUses: 5 },
					scope: 'row',
					layout: 'detail',
					filter: undefined,
				}),
			),
		)
		expect(second).toEqual([])
	})
})

// ---------------------------------------------------------------------------
// The edit ops.
// ---------------------------------------------------------------------------

describe('portals.setFields — the exposure edit', () => {
	it('replaces the projection wholesale', () => {
		const spec = applyOp(
			declared(),
			{
				op: 'portals.setFields',
				args: { portalId: 'ptl-archive', readFields: ['fld-title'] },
			},
			meta(3),
		)
		expect(findPortal(spec, 'archive')?.readFields).toEqual(['fld-title'])
	})

	it('re-validates against the AUDIENCE, so a file field cannot be added later', () => {
		// The trap this prevents: validating the id list alone would accept a
		// projection that is only legal for a portal this is not.
		expect(
			validateOp(declared(), {
				op: 'portals.setFields',
				args: { portalId: 'ptl-archive', readFields: ['fld-hero'] },
			}).join('\n'),
		).toMatch(/STORAGE KEY/)
	})

	it('names the audience and the field count in the diff a human reviews', () => {
		const diff = diffOp({
			op: 'portals.setFields',
			args: { portalId: 'ptl-archive', readFields: ['fld-title', 'fld-body'] },
		})
		expect(diff.summary).toMatch(/Expose 2 field\(s\)/)
	})
})

describe('portals.setWrites — a separate decision from a wider projection', () => {
	it('replaces the write surface wholesale and can make a portal read-only', () => {
		const spec = applyOp(
			declared({
				writes: [
					{ action: 'create', fieldIds: ['fld-title'], rateLimitPerHour: 60 },
				],
			}),
			{
				op: 'portals.setWrites',
				args: { portalId: 'ptl-archive', writes: [] },
			},
			meta(4),
		)
		expect(findPortal(spec, 'archive')?.writes).toEqual([])
	})

	it('still refuses an anonymous update when it arrives through the edit op', () => {
		expect(
			validateOp(declared(), {
				op: 'portals.setWrites',
				args: {
					portalId: 'ptl-archive',
					writes: [
						{ action: 'update', fieldIds: ['fld-title'], rateLimitPerHour: 5 },
					],
				},
			}).join('\n'),
		).toMatch(/may not declare "update"/)
	})

	it('says READ-ONLY in the diff when the writes are removed', () => {
		expect(
			diffOp({
				op: 'portals.setWrites',
				args: { portalId: 'ptl-archive', writes: [] },
			}).summary,
		).toMatch(/READ-ONLY/)
	})
})

describe('portals.pause — the op somebody runs at 3am', () => {
	it('takes the portal offline without losing the declaration', () => {
		const spec = applyOp(
			declared(),
			{ op: 'portals.pause', args: { portalId: 'ptl-archive', paused: true } },
			meta(5),
		)
		expect(findPortal(spec, 'archive')?.paused).toBe(true)
		// Everything that made it reviewable survives.
		expect(findPortal(spec, 'archive')?.readFields).toHaveLength(2)
		expect(activePortals(spec)).toEqual([])
		expect(listPortals(spec)).toHaveLength(1)
	})

	it('does not reach a suggestion nobody accepted, even as the only portal', () => {
		// The deliberate asymmetry with `activeImporters`/`activeSources`, which
		// fall back to "every row" when none is accepted. Here that fallback would
		// mean an agent could put a table on the internet by SUGGESTING it, which
		// is default-open. See `activePortals`.
		const spec = declared({ provenance: suggested() })
		expect(listPortals(spec)).toHaveLength(1)
		expect(activePortals(spec)).toEqual([])
	})

	it('reaches a portal a person wrote by hand, with no separate accept step', () => {
		expect(activePortals(declared())).toHaveLength(1)
	})
})

describe('portals.remove — refused while the surface is still answering', () => {
	it('refuses removal of a live portal and names the op that stops it', () => {
		expect(
			validateOp(declared(), {
				op: 'portals.remove',
				args: { portalId: 'ptl-archive' },
			}).join('\n'),
		).toMatch(/pause it with portals.pause/)
	})

	it('removes a paused portal', () => {
		const paused = applyOp(
			declared(),
			{ op: 'portals.pause', args: { portalId: 'ptl-archive', paused: true } },
			meta(6),
		)
		expect(
			validateOp(paused, {
				op: 'portals.remove',
				args: { portalId: 'ptl-archive' },
			}),
		).toEqual([])
		const gone = applyOp(
			paused,
			{ op: 'portals.remove', args: { portalId: 'ptl-archive' } },
			meta(7),
		)
		expect(listPortals(gone)).toEqual([])
	})
})

// ---------------------------------------------------------------------------
// The exposure report.
// ---------------------------------------------------------------------------

describe('the exposure report is the review artifact', () => {
	it('lists every field every portal exposes, with the audience and the access', () => {
		const spec = declared({
			writes: [
				{ action: 'create', fieldIds: ['fld-title'], rateLimitPerHour: 60 },
			],
		})
		expect(portalExposureReport(spec)).toEqual([
			{
				portalId: 'ptl-archive',
				portalKey: 'archive',
				audience: 'public',
				entityId: 'e-post',
				fieldId: 'fld-body',
				access: 'read',
			},
			{
				portalId: 'ptl-archive',
				portalKey: 'archive',
				audience: 'public',
				entityId: 'e-post',
				fieldId: 'fld-title',
				access: 'read',
			},
			{
				portalId: 'ptl-archive',
				portalKey: 'archive',
				audience: 'public',
				entityId: 'e-post',
				fieldId: 'fld-title',
				access: 'create',
			},
		])
	})

	it('never mentions a field nobody declared, including one on the same entity', () => {
		const report = portalExposureReport(declared())
		expect(report.map((r) => r.fieldId)).not.toContain('fld-notes')
	})

	it('includes a PAUSED portal, because a pause is one op from being undone', () => {
		const paused = applyOp(
			declared(),
			{ op: 'portals.pause', args: { portalId: 'ptl-archive', paused: true } },
			meta(8),
		)
		expect(portalExposureReport(paused)).toHaveLength(2)
	})

	it('is deterministic, so a diff of two reports is a diff of the exposure', () => {
		const spec = declared()
		expect(portalExposureReport(spec)).toEqual(portalExposureReport(spec))
	})

	it('says "no portals" in words rather than printing an empty table', () => {
		expect(summarizeExposure(portalExposureReport(withPost()))).toMatch(
			/No portals declared/,
		)
	})

	it('leads with the count of fields readable with NO credential at all', () => {
		expect(summarizeExposure(portalExposureReport(declared()))).toMatch(
			/2 field\(s\) readable with no credential at all/,
		)
	})
})

describe('describePortal', () => {
	it('always names the audience and the field count', () => {
		expect(describePortal(portal())).toBe(
			'public collection over e-post, 2 field(s), read-only',
		)
	})

	it('names the pause state, which is what a reader most needs from a stale diff', () => {
		expect(describePortal(portal({ paused: true }))).toMatch(/, paused$/)
	})
})

describe('the declare diff is what a human reads before this reaches the internet', () => {
	it('shouts the audience and states the field count', () => {
		const diff = diffOp(declare(portal()))
		expect(diff.summary).toMatch(/Declare PUBLIC portal "archive"/)
		expect(diff.summary).toMatch(/exposing 2 field\(s\)/)
	})
})

describe('a hand-edited portals.json is refused exactly as an op would be', () => {
	it('rejects the same shapes through collectSpecSystemErrors', () => {
		const spec = declared()
		const tampered: SpecSystem = {
			...spec,
			portals: {
				portals: [
					{ ...portal(), readFields: ['fld-hero'] } as PortalSpec,
					// A second portal squatting the first one's URL.
					{ ...portal(), id: 'ptl-dupe' } as PortalSpec,
				],
			},
		}
		const errors = collectSpecSystemErrors(tampered).join('\n')
		expect(errors).toMatch(/STORAGE KEY/)
		expect(errors).toMatch(/duplicate portal key/)
	})
})
