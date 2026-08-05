import { describe, expect, it } from 'vitest'
import { tasklyPRD } from '../fixtures/index.ts'
import {
	decodeSpecSystem,
	encodeSpecSystem,
	isSpecDir,
	OPTIONAL_SPEC_DIR_FILES,
	SPEC_DIR_FILES,
	SPEC_FORMAT_VERSION,
} from './spec-codec.ts'
import { type ApplyMeta, applyOp, type SpecOp } from './spec-ops.ts'
import { validateSpecSystem } from './spec-system.schema.ts'
import { newSpecSystem, resolveTheme, type SpecSystem } from './spec-system.ts'

const meta = (n: number): ApplyMeta => ({
	actor: { surface: 'harness' },
	id: `op-${n}`,
	origin: n % 2 === 0 ? 'human' : 'ai',
	appliedAt: '2026-07-14',
})

/** A small but representative system: an entity (+field), a page (+block), a
 * pricing tier, a decision, and one review — exercising every op-log branch. */
function sampleSystem(): SpecSystem {
	let s = newSpecSystem(tasklyPRD)
	const ops: SpecOp[] = [
		// --- product-layer ops (redundant with product.json / ledger.json) ------
		{
			op: 'prd.addMetric',
			args: {
				metric: {
					id: 'm-codec',
					name: 'Codec metric',
					definition: 'a supporting metric for the codec test',
					baseline: 0,
				},
			},
		},
		{
			op: 'prd.addRequirement',
			args: {
				intoPhaseId: 'p-mvp', // tasklyPRD has phase p-mvp → exercises diff.parentId
				requirement: {
					id: 'r-codec',
					userStory: 'as a user, I round-trip',
					acceptanceCriteria: ['works'],
					priority: 'P1',
					edgeCasesAndErrorStates: [],
					servesMetricIds: ['m-codec'],
				},
			},
		},
		{
			op: 'prd.addScopeItem',
			args: {
				bucket: 'mustHave', // bucket rides in diff.parentId
				item: {
					id: 's-codec',
					description: 'core',
					realizedByRequirementId: 'r-codec',
				},
			},
		},
		{
			op: 'prd.addRisk',
			args: {
				risk: {
					id: 'rk-codec',
					description: 'the codec drifts',
					type: 'technical_risk',
					likelihood: 0.3,
					impact: 0.6,
					mitigation: 'round-trip tests',
				},
			},
		},
		{
			op: 'prd.recordDecision',
			args: {
				entry: {
					id: 'd-codec',
					question: 'split or monolith?',
					options: [
						{
							id: 'split',
							description: 'directory',
							pros: ['legible'],
							cons: [],
						},
						{ id: 'mono', description: 'one file', pros: [], cons: ['long'] },
					],
					recommendedOptionId: 'split',
					chosenOptionId: 'split',
					rationale: 'legibility wins',
					status: 'resolved',
					decidedAt: '2026-07-14',
					origin: 'human',
					recordedAt: '2026-07-14',
				},
			},
		},
		// --- data / page / pricing / review ------------------------------------
		{
			op: 'data.addEntity',
			args: {
				entity: {
					id: 'e-invoice',
					name: 'Invoice',
					description: 'A bill.',
					fields: [
						{ id: 'fld-total', name: 'total', type: 'number', required: true },
					],
				},
			},
		},
		{
			op: 'data.addField',
			args: {
				entityId: 'e-invoice',
				field: {
					id: 'fld-status',
					name: 'status',
					type: 'string',
					required: false,
				},
			},
		},
		{
			op: 'page.addPage',
			args: {
				page: {
					id: 'pg-invoices',
					name: 'Invoices',
					route: '/invoices',
					entityId: 'e-invoice',
					blocks: [{ id: 'blk-table', type: 'table' }],
				},
			},
		},
		{
			op: 'page.addBlock',
			args: { pageId: 'pg-invoices', block: { id: 'blk-form', type: 'form' } },
		},
		{
			op: 'pricing.addTier',
			args: {
				tier: {
					id: 'tr-pro',
					name: 'Pro',
					priceMonthly: 20,
					features: ['all'],
				},
			},
		},
		{
			op: 'provenance.review',
			args: {
				target: { kind: 'entity', id: 'e-invoice' },
				action: 'accept',
				cascade: true,
			},
		},
	]
	ops.forEach((op, i) => {
		s = applyOp(s, op, meta(i + 1))
	})
	return s
}

/** The audit essence of the log that must round-trip exactly (the reconstructed
 * `.op` payload is a convenience pointer at live state, not part of the contract). */
const logEssence = (s: SpecSystem) =>
	s.opLog.map(({ id, origin, appliedAt, diff }) => ({
		id,
		origin,
		appliedAt,
		diff,
	}))

describe('spec-codec directory round-trip', () => {
	it('round-trips state and preserves the log audit record', () => {
		const s = sampleSystem()
		const dir = encodeSpecSystem(s)
		const decoded = decodeSpecSystem(dir)
		// data/pages/pricing/ledger/policy are byte-for-byte identical
		expect(decoded.data).toEqual(s.data)
		expect(decoded.pages).toEqual(s.pages)
		expect(decoded.pricing).toEqual(s.pricing)
		expect(decoded.ledger).toEqual(s.ledger)
		expect(decoded.autoAccept).toBe(s.autoAccept)
		// the PRD round-trips up to empty-container normalization: real content is
		// preserved (requirements carry the meaty arrays) and the on-disk form is
		// stable (re-encoding the decode reproduces product.json exactly).
		expect(decoded.product.requirements).toEqual(s.product.requirements)
		expect(decoded.product.meta.title).toBe(s.product.meta.title)
		expect(encodeSpecSystem(decoded)[SPEC_DIR_FILES.product]).toBe(
			dir[SPEC_DIR_FILES.product],
		)
		// the op log's audit essence (id/origin/appliedAt/diff) survives exactly,
		// and every entry still resolves to a valid op of the same name
		expect(logEssence(decoded)).toEqual(logEssence(s))
		expect(decoded.opLog.map((o) => o.op.op)).toEqual(
			s.opLog.map((o) => o.op.op),
		)
		// and it's still a valid spec system after the round trip
		expect(() => validateSpecSystem(decoded)).not.toThrow()
	})

	it('drops empty PRD containers on disk and refills them on load', () => {
		const s = sampleSystem()
		// force some noisy-empty containers
		s.product.openQuestions = []
		s.product.scope.shouldHave = []
		s.product.constraints = {}
		const product = encodeSpecSystem(s)[SPEC_DIR_FILES.product] ?? ''
		expect(product).not.toContain('"openQuestions"')
		expect(product).not.toContain('"shouldHave"')
		expect(product).not.toContain('"constraints"')
		// on load they come back, so validatePRD (which dereferences them) is happy
		const decoded = decodeSpecSystem(encodeSpecSystem(s))
		expect(decoded.product.openQuestions).toEqual([])
		expect(decoded.product.scope.shouldHave).toEqual([])
		expect(decoded.product.constraints).toEqual({})
		expect(() => validateSpecSystem(decoded)).not.toThrow()
	})

	it('splits into per-layer files with a version + policy meta', () => {
		const dir = encodeSpecSystem(sampleSystem())
		// The optional layer files appear only once their layer has been touched:
		// theme.json on a theme.set, flags.json on a flags.declare,
		// schedules.json on a schedules.declare, sources.json on a
		// sources.declare, search.json on a search.declare,
		// documents.json on a documents.declare, imports.json on an
		// imports.declare, portals.json on a portals.declare,
		// live.json on a live.declare.
		expect(Object.keys(dir).sort()).toEqual(
			Object.values(SPEC_DIR_FILES)
				.filter(
					(f) =>
						f !== SPEC_DIR_FILES.theme &&
						f !== SPEC_DIR_FILES.flags &&
						f !== SPEC_DIR_FILES.schedules &&
						f !== SPEC_DIR_FILES.sources &&
						f !== SPEC_DIR_FILES.search &&
						f !== SPEC_DIR_FILES.documents &&
						f !== SPEC_DIR_FILES.imports &&
						f !== SPEC_DIR_FILES.portals &&
						f !== SPEC_DIR_FILES.live,
				)
				.sort(),
		)
		expect(isSpecDir(dir)).toBe(true)
		expect(JSON.parse(dir[SPEC_DIR_FILES.meta] ?? '')).toEqual({
			formatVersion: SPEC_FORMAT_VERSION,
			autoAccept: false,
		})
	})

	it('round-trips the theme once set, tolerates its absence, keeps theme.set inline in the log', () => {
		// absence: a pre-theme directory decodes with no theme → zinc default
		const bare = decodeSpecSystem(encodeSpecSystem(sampleSystem()))
		expect(bare.theme).toBeUndefined()
		expect(resolveTheme(bare)).toEqual({ preset: 'zinc' })

		const s = applyOp(
			sampleSystem(),
			{
				op: 'theme.set',
				args: { theme: { preset: 'ocean', accent: '#0ea5e9', radius: 'lg' } },
			},
			meta(20),
		)
		const dir = encodeSpecSystem(s)
		expect(dir[SPEC_DIR_FILES.theme]).toBeDefined()
		const decoded = decodeSpecSystem(dir)
		expect(decoded.theme).toEqual(s.theme)
		expect(logEssence(decoded)).toEqual(logEssence(s))
		// last-wins ops aren't recoverable from final state → op stays inline
		const line = (dir[SPEC_DIR_FILES.oplog] ?? '')
			.trim()
			.split('\n')
			.map((l) => JSON.parse(l))
			.find((l) => l.diff.op === 'theme.set')
		expect(line.op).toEqual({
			op: 'theme.set',
			args: { theme: { preset: 'ocean', accent: '#0ea5e9', radius: 'lg' } },
		})
		expect(() => validateSpecSystem(decoded)).not.toThrow()
	})

	it('round-trips flags once declared, tolerates their absence, and survives a removal', () => {
		// absence: a pre-#187 directory decodes with no flags at all
		expect(
			decodeSpecSystem(encodeSpecSystem(sampleSystem())).flags,
		).toBeUndefined()

		const declared = applyOp(
			sampleSystem(),
			{
				op: 'flags.declare',
				args: {
					flag: {
						id: 'flg-checkout-v2',
						key: 'checkout-v2',
						description: 'The rebuilt checkout flow.',
						default: false,
						targeting: { rolloutPercent: 10 },
					},
				},
			},
			meta(30),
		)
		const dir = encodeSpecSystem(declared)
		expect(dir[SPEC_DIR_FILES.flags]).toBeDefined()
		const decoded = decodeSpecSystem(dir)
		expect(decoded.flags).toEqual(declared.flags)
		expect(logEssence(decoded)).toEqual(logEssence(declared))
		expect(() => validateSpecSystem(decoded)).not.toThrow()

		// The removal case is why flags.declare keeps its payload inline: after a
		// remove, the row a historical declare created is gone, so reconstructing
		// it from state would throw on a perfectly valid log.
		const removed = applyOp(
			declared,
			{ op: 'flags.remove', args: { flagId: 'flg-checkout-v2' } },
			meta(31),
		)
		const reread = decodeSpecSystem(encodeSpecSystem(removed))
		expect(reread.flags).toEqual({ flags: [] })
		expect(logEssence(reread)).toEqual(logEssence(removed))
	})

	it('drops redundant add-op payloads from the log (reconstructed on load)', () => {
		const dir = encodeSpecSystem(sampleSystem())
		const lines = (dir[SPEC_DIR_FILES.oplog] ?? '')
			.trim()
			.split('\n')
			.map((l) => JSON.parse(l))
		const addEntity = lines.find((l) => l.diff.op === 'data.addEntity')
		const recordDecision = lines.find((l) => l.diff.op === 'prd.recordDecision')
		const review = lines.find((l) => l.diff.op === 'provenance.review')
		// heavy add-ops store no inline `op` — both the data layer …
		expect(addEntity.op).toBeUndefined()
		expect(addEntity.diff.targetId).toBe('e-invoice')
		// … and the product layer (the decision also lives in ledger.json)
		expect(recordDecision.op).toBeUndefined()
		expect(recordDecision.diff.targetId).toBe('d-codec')
		// the review op is NOT recoverable from state, so it keeps its `op` inline
		expect(review.op).toBeDefined()
	})

	it('compacts provenance: a manual row omits the key, others use a code', () => {
		let s = newSpecSystem(tasklyPRD)
		// origin human → manual() default (omitted); origin ai → accepted suggestion ('a')
		s = applyOp(
			s,
			{
				op: 'data.addEntity',
				args: {
					entity: {
						id: 'e-a',
						name: 'A',
						fields: [
							{ id: 'fld-x', name: 'x', type: 'string', required: true },
						],
					},
				},
			},
			{
				actor: { surface: 'harness' },
				id: 'op-1',
				origin: 'human',
				appliedAt: '2026-07-14',
			},
		)
		s = applyOp(
			s,
			{
				op: 'data.addEntity',
				args: {
					entity: {
						id: 'e-b',
						name: 'B',
						fields: [
							{ id: 'fld-y', name: 'y', type: 'string', required: true },
						],
					},
				},
			},
			{
				actor: { surface: 'harness' },
				id: 'op-2',
				origin: 'ai',
				appliedAt: '2026-07-14',
			},
		)
		const data = JSON.parse(encodeSpecSystem(s)[SPEC_DIR_FILES.data] ?? '')
		const [a, b] = data.entities
		expect(a.provenance).toBeUndefined() // manual → omitted
		expect(a.fields[0].provenance).toBeUndefined()
		expect(b.provenance).toBe('a') // accepted suggestion → code
		// state round-trips exactly regardless of compaction
		const decoded = decodeSpecSystem(encodeSpecSystem(s))
		expect(decoded.data).toEqual(s.data)
	})
})

describe('external data sources', () => {
	const withSource = (): SpecSystem =>
		applyOp(
			applyOp(
				sampleSystem(),
				{
					op: 'data.addEntity',
					args: {
						entity: {
							id: 'e-book',
							name: 'Book',
							fields: [
								{
									id: 'fld-isbn',
									name: 'isbn',
									type: 'string',
									required: true,
								},
								{
									id: 'fld-title',
									name: 'title',
									type: 'string',
									required: true,
								},
							],
						},
					},
				} as SpecOp,
				{
					actor: { surface: 'harness' },
					id: 'op-c1',
					origin: 'human',
					appliedAt: '2026-07-28',
				},
			),
			{
				op: 'sources.declare',
				args: {
					source: {
						id: 'src-isbn',
						key: 'isbn.lookup',
						description: 'Look a book up by ISBN.',
						mode: 'enrich',
						entityId: 'e-book',
						request: { url: 'https://openlibrary.org/isbn/{isbn}.json' },
						auth: { kind: 'bearer', secretName: 'OPENLIBRARY_TOKEN' },
						mapping: [{ from: 'title', to: 'fld-title' }],
						limits: {
							requestsPerMinute: 30,
							timeoutMs: 5000,
							maxAttempts: 3,
							backoffMs: 1000,
						},
						triggers: [{ kind: 'create' }],
						inputField: 'fld-isbn',
					},
				},
			} as SpecOp,
			{
				actor: { surface: 'harness' },
				id: 'op-c2',
				origin: 'human',
				appliedAt: '2026-07-28',
			},
		)

	it('writes sources.json only once a source is declared, and round-trips it', () => {
		// The trap #187 shipped and this constant now prevents: a new optional
		// layer file has to be tolerated in BOTH directions, or every project on
		// disk reads as having no spec at all.
		const dir = encodeSpecSystem(withSource())
		expect(dir[SPEC_DIR_FILES.sources]).toBeDefined()
		expect(OPTIONAL_SPEC_DIR_FILES).toContain(SPEC_DIR_FILES.sources)
		const decoded = decodeSpecSystem(dir)
		expect(decoded.sources).toEqual(withSource().sources)
		expect(() => validateSpecSystem(decoded)).not.toThrow()
	})

	it('tolerates a pre-#173 directory that has no sources.json', () => {
		const dir = encodeSpecSystem(withSource())
		delete dir[SPEC_DIR_FILES.sources]
		expect(decodeSpecSystem(dir).sources).toBeUndefined()
	})

	it('writes imports.json only once an importer is declared, and round-trips it', () => {
		// The same both-directions trap, checked for the same reason: `readSpecDir`
		// and `writeSpecDir` read `OPTIONAL_SPEC_DIR_FILES` rather than their own
		// lists, so a new layer file cannot be tolerated in one and not the other.
		const withImporter = applyOp(
			withSource(),
			{
				op: 'imports.declare',
				args: {
					importer: {
						id: 'imp-books',
						key: 'books-csv',
						description: 'Import a book list exported from the old tool.',
						entityId: 'e-book',
						format: 'csv',
						columns: [
							{ column: 'ISBN', fieldId: 'fld-isbn' },
							{ column: 'Title', fieldId: 'fld-title' },
						],
						upsertFieldId: 'fld-isbn',
						maxRows: 5000,
						paused: false,
					},
				},
			} as SpecOp,
			{
				actor: { surface: 'harness' },
				id: 'op-c3',
				origin: 'human',
				appliedAt: '2026-07-28',
			},
		)
		const dir = encodeSpecSystem(withImporter)
		expect(dir[SPEC_DIR_FILES.imports]).toBeDefined()
		expect(OPTIONAL_SPEC_DIR_FILES).toContain(SPEC_DIR_FILES.imports)
		const decoded = decodeSpecSystem(dir)
		expect(decoded.imports).toEqual(withImporter.imports)
		expect(() => validateSpecSystem(decoded)).not.toThrow()

		// A pre-#175 directory has no imports.json and decodes to no layer at all.
		delete dir[SPEC_DIR_FILES.imports]
		expect(decodeSpecSystem(dir).imports).toBeUndefined()
	})

	it('writes portals.json only once a portal is declared, and round-trips it', () => {
		// The same both-directions trap once more, and this is the layer where
		// getting it wrong costs the most: a spec dir with no `portals.json` means
		// "nothing here is reachable without a session", so a codec that dropped the
		// file would silently answer that question wrongly in the safe direction on
		// read and in the unsafe direction on write.
		const withPortal = applyOp(
			withSource(),
			{
				op: 'portals.declare',
				args: {
					portal: {
						id: 'ptl-catalog',
						key: 'catalog',
						description: 'The public catalogue of one shelf.',
						entityId: 'e-book',
						audience: 'public',
						scope: 'collection',
						readFields: ['fld-title'],
						filter: { fieldId: 'fld-isbn', equals: '978' },
						writes: [],
						layout: 'cards',
						paused: false,
					},
				},
			} as SpecOp,
			{
				actor: { surface: 'harness' },
				id: 'op-c4',
				origin: 'human',
				appliedAt: '2026-07-29',
			},
		)
		const dir = encodeSpecSystem(withPortal)
		expect(dir[SPEC_DIR_FILES.portals]).toBeDefined()
		expect(OPTIONAL_SPEC_DIR_FILES).toContain(SPEC_DIR_FILES.portals)
		const decoded = decodeSpecSystem(dir)
		expect(decoded.portals).toEqual(withPortal.portals)
		expect(() => validateSpecSystem(decoded)).not.toThrow()

		// A pre-#177 directory has no portals.json and decodes to no layer at all —
		// which is the correct reading of a project that has no outside.
		delete dir[SPEC_DIR_FILES.portals]
		expect(decodeSpecSystem(dir).portals).toBeUndefined()
	})

	it('writes live.json only once a subscription is declared, and round-trips it', () => {
		// The both-directions trap one more time. A spec dir with no `live.json`
		// means "every derived surface is a snapshot and nothing holds a connection
		// open"; a codec that dropped the file on read would quietly turn a declared
		// channel into no channel, and one that materialized an empty file on write
		// would break the absence-means-default rule for every project that predates
		// this layer.
		const withLive = applyOp(
			withSource(),
			{
				op: 'live.declare',
				args: {
					subscription: {
						id: 'lv-shelf',
						key: 'shelf',
						description: 'Push shelf changes to whoever is looking at it.',
						entityId: 'e-book',
						kind: 'query',
						fields: ['fld-title'],
						scope: { kind: 'all' },
						maxSubscribers: 50,
						maxMessagesPerMinute: 60,
						slot: false,
						paused: false,
					},
				},
			} as SpecOp,
			{
				actor: { surface: 'harness' },
				id: 'op-c5',
				origin: 'human',
				appliedAt: '2026-07-29',
			},
		)
		const dir = encodeSpecSystem(withLive)
		expect(dir[SPEC_DIR_FILES.live]).toBeDefined()
		expect(OPTIONAL_SPEC_DIR_FILES).toContain(SPEC_DIR_FILES.live)
		const decoded = decodeSpecSystem(dir)
		expect(decoded.live).toEqual(withLive.live)
		expect(() => validateSpecSystem(decoded)).not.toThrow()

		// A pre-#179 directory has no live.json and decodes to no layer at all.
		delete dir[SPEC_DIR_FILES.live]
		expect(decodeSpecSystem(dir).live).toBeUndefined()
	})

	it('carries the credential NAME through the codec and never a value', () => {
		const dir = encodeSpecSystem(withSource())
		const raw = dir[SPEC_DIR_FILES.sources] ?? ''
		expect(raw).toContain('OPENLIBRARY_TOKEN')
		// There is nothing else to leak: the declaration never held a value.
		expect(raw).not.toMatch(/Bearer\s+\S/)
	})
})
