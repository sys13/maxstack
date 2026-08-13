/**
 * Grounding: fold the platform spec's data layer into the structural entity
 * shapes the core spec→Sprout bridge consumes. Pure (unit-testable) — the
 * server wiring in `sprout.server.ts` decides *when* to re-ground.
 *
 * Both invariant helpers apply here: `getAcceptedOrAll` grounds entities and
 * fields on accepted rows (falling back to all while nothing is decided yet),
 * and manual rows count as accepted (`manual()` sets `isAccepted: true`), so a
 * hand-added field never drops out of the live schema. Soft-rejected rows
 * (`isAccepted: false`) stop grounding as soon as any sibling is accepted.
 */

import {
	type ActionPlan,
	type ComputedNode,
	type ComputedShape,
	type DocumentFieldPlan,
	type DocumentPlan,
	type DocumentSectionPlan,
	type DocumentStyle,
	type ImportPlanShape,
	type ImportValueType,
	type LivePlan,
	type PortalPlan,
	pickTitleField,
	type RollupHop,
	type RollupShape,
	type SearchIndexPlan,
	type SearchWeight,
	type SpecEntityShape,
	type SproutColumnReference,
} from '@maxstack/core'
import {
	activeActions,
	documentTemplatesFor,
	findSearchIndex,
	getAcceptedOrAll,
	importersFor,
	listLiveSubscriptions,
	orderedSearchFields,
	portalsFor,
	resolveTheme,
	type SpecSystem,
	virtualEntity,
} from '@maxstack/spec'

/** `e-reading-item` → `reading-item` — the same derivation the page
 * generator's `pageDescriptor` uses, so tables and routes agree on names. */
const resourceName = (entityId: string) => entityId.replace(/^e-/, '')

type SpecEntities = readonly SpecSystem['data']['entities'][number][]

/** The entity's display field — the same `pickTitleField` pick
 * `registerSpecEntities` makes (name-ish string field, never an FK). Used as a
 * reference's `displayField` so an FK resolves to the referenced record's
 * title, not its id. */
function titleFieldOf(
	entities: SpecEntities,
	entityId: string,
): string | undefined {
	const entity = entities.find((e) => e.id === entityId)
	return entity ? pickTitleField(entity.fields) : undefined
}

export interface GroundingOptions {
	/**
	 * Installed bundle slugs (from `maxstack.json`). A reference to a virtual
	 * entity (`e-user` → the auth bundle's `user` table) only grounds
	 * when its bundle is installed — otherwise the field lands as a plain column
	 * so the runtime never tries to resolve rows out of a table that does not
	 * exist. Omitted = every virtual entity counts as available (pure callers).
	 */
	installedBundles?: readonly string[]
}

/**
 * Ground one `field.reference` target. A spec entity wins (including over a
 * virtual entity with the same id — shadowing); otherwise a well-known virtual
 * entity grounds to its bundle's table when that bundle is installed, and to
 * nothing (a plain column) when it isn't.
 */
function groundReference(
	entities: SpecEntities,
	reference: string,
	installedBundles?: readonly string[],
): SproutColumnReference | undefined {
	if (!entities.some((e) => e.id === reference)) {
		const virtual = virtualEntity(reference)
		if (virtual) {
			const available =
				installedBundles === undefined ||
				installedBundles.includes(virtual.bundle)
			return available
				? {
						table: virtual.table,
						column: virtual.column,
						displayField: virtual.displayField,
						idType: virtual.idType,
					}
				: undefined
		}
	}
	return {
		table: resourceName(reference),
		column: 'id',
		displayField: titleFieldOf(entities, reference),
	}
}

/**
 * Ground a computed expression's leaves from field **ids** to column **names**
 *. A leaf the entity does not carry — a field soft-rejected after
 * the computed value was authored — makes the whole expression ungroundable, and
 * the caller drops it: a formula with a missing operand has no defensible value,
 * and substituting 0 would quietly report a wrong number.
 */
function groundComputedExpr(
	entity: SpecSystem['data']['entities'][number],
	expr: unknown,
): ComputedNode | undefined {
	if (typeof expr !== 'object' || expr === null) return undefined
	const node = expr as Record<string, unknown>
	if (node.kind === 'literal') {
		return typeof node.value === 'number'
			? { kind: 'literal', value: node.value }
			: undefined
	}
	if (node.kind === 'field') {
		const field = getAcceptedOrAll(entity.fields).find(
			(f) => f.id === node.field,
		)
		return field ? { kind: 'field', field: field.name } : undefined
	}
	if (node.kind === 'binary') {
		const left = groundComputedExpr(entity, node.left)
		const right = groundComputedExpr(entity, node.right)
		if (!left || !right) return undefined
		return {
			kind: 'binary',
			op: node.op as ComputedNode & { op: never }['op'],
			left,
			right,
		}
	}
	return undefined
}

/** Ground an entity's computed fields, dropping any whose operands no longer resolve. */
function groundComputed(
	entity: SpecSystem['data']['entities'][number],
): ComputedShape[] {
	const out: ComputedShape[] = []
	for (const c of getAcceptedOrAll(entity.computed ?? [])) {
		const expr = groundComputedExpr(entity, c.expr)
		if (expr) out.push({ name: c.name, expr })
	}
	return out
}

/**
 * Ground an entity's rollups — resolve the aggregated table, the
 * relation path, the aggregated column, filters, and the group-by key from spec
 * ids to runtime names.
 *
 * A rollup whose targets no longer resolve is **dropped**, not degraded. The op
 * validator proved every reference at apply time, so getting here means something
 * was soft-rejected afterwards; showing an aggregate over a relation that no
 * longer exists would be worse than showing nothing.
 */
function groundRollups(
	entities: SpecEntities,
	entity: SpecSystem['data']['entities'][number],
): RollupShape[] {
	const out: RollupShape[] = []
	for (const rollup of getAcceptedOrAll(entity.rollups ?? [])) {
		const over = entities.find((e) => e.id === rollup.over)
		if (!over) continue

		// Walk the `via` path, resolving each hop's FK column and target table.
		let hops: RollupHop[] | undefined
		if (rollup.via !== undefined) {
			const ids = Array.isArray(rollup.via) ? rollup.via : [rollup.via]
			const resolved: RollupHop[] = []
			let current = over
			let ok = true
			for (const id of ids) {
				const fk = getAcceptedOrAll(current.fields).find((f) => f.id === id)
				if (!fk?.reference) {
					ok = false
					break
				}
				resolved.push({ column: fk.name, table: resourceName(fk.reference) })
				const next = entities.find((e) => e.id === fk.reference)
				if (!next) break // last hop lands on the owner; no further lookup needed
				current = next
			}
			if (!ok || resolved.length === 0) continue
			hops = resolved
		}

		// The aggregated value: a stored column, or an inlined computed expression.
		let column: string | undefined
		let computed: ComputedNode | undefined
		if (rollup.field !== undefined) {
			const stored = getAcceptedOrAll(over.fields).find(
				(f) => f.id === rollup.field,
			)
			if (stored) {
				column = stored.name
			} else {
				const derived = getAcceptedOrAll(over.computed ?? []).find(
					(c) => c.id === rollup.field,
				)
				computed = derived ? groundComputedExpr(over, derived.expr) : undefined
				if (!computed) continue
			}
		}

		const where: RollupShape['where'] = []
		let filtersOk = true
		for (const filter of rollup.where ?? []) {
			const target = getAcceptedOrAll(over.fields).find(
				(f) => f.id === filter.field,
			)
			if (!target) {
				filtersOk = false
				break
			}
			where.push({ column: target.name, equals: filter.equals })
		}
		if (!filtersOk) continue

		let groupBy: RollupShape['groupBy']
		if (rollup.groupBy) {
			const key = getAcceptedOrAll(over.fields).find(
				(f) => f.id === rollup.groupBy?.field,
			)
			if (!key) continue
			groupBy = { column: key.name, bucket: rollup.groupBy.bucket }
		}

		out.push({
			name: rollup.name,
			over: resourceName(rollup.over),
			...(hops ? { via: hops } : {}),
			fn: rollup.fn,
			...(column ? { column } : {}),
			...(computed ? { computed } : {}),
			...(where.length > 0 ? { where } : {}),
			...(groupBy ? { groupBy } : {}),
			...(rollup.limit !== undefined ? { limit: rollup.limit } : {}),
		})
	}
	return out
}

/**
 * Ground an entity's declared search index: field *ids* resolved to
 * column *names*, in rank order.
 *
 * Returns `undefined` — no index at all — when the declaration names a field
 * that is not on the accepted entity. That is the honest failure: the DDL and
 * the query are built from the same plan, so a plan with a missing column would
 * either fail to create the index or, worse, create one whose expression the
 * query cannot reproduce, leaving a silent sequential scan. Refusing to ground a
 * partial index means the resource has no search endpoint and says so, which the
 * validator has already refused to let happen in the first place; this is the
 * belt for a spec that reached here without passing it (a field soft-rejected
 * after the index was declared).
 */
function groundSearch(
	spec: SpecSystem,
	entity: SpecSystem['data']['entities'][number],
): SearchIndexPlan | undefined {
	const index = findSearchIndex(spec, entity.id)
	if (!index) return undefined
	const byId = new Map(
		getAcceptedOrAll(entity.fields).map((f) => [f.id, f.name] as const),
	)
	const fields: { column: string; weight: SearchWeight }[] = []
	for (const field of orderedSearchFields(index)) {
		const column = byId.get(field.fieldId)
		if (!column) return undefined
		fields.push({ column, weight: field.weight })
	}
	if (fields.length === 0) return undefined
	return {
		key: index.key,
		language: index.language,
		fields,
		indexed: index.indexed,
	}
}

/**
 * The theme, as the two backends' style.
 *
 * This function is the whole of the "documents are not a second UI system"
 * claim, made mechanical: there is no document theme to resolve, so the only
 * thing there *is* to read is `theme.set`'s. The five theme fonts collapse to
 * three here because a printed page has three kinds of typeface — `rounded` and
 * `humanist` are distinctions webfonts make, and a document ships no webfont.
 */
function groundDocumentStyle(spec: SpecSystem): DocumentStyle {
	const theme = resolveTheme(spec)
	const font: DocumentStyle['font'] =
		theme.font === 'serif' ? 'serif' : theme.font === 'mono' ? 'mono' : 'sans'
	return {
		font,
		// The preset's own accent is a UI-side palette lookup; a template's accent
		// is only ever the explicit override, falling back to a neutral ink. A
		// document printed in a preset's brand hue nobody chose would be a surprise
		// on paper in a way it is not on screen.
		accent: theme.accent ?? '#111111',
		density: theme.density ?? 'comfortable',
		typeScale: theme.typeScale ?? 'default',
	}
}

/**
 * Every printable value on an entity, keyed by *name* — what a section's field
 * ids and a `{placeholder}` both resolve through.
 *
 * Keyed by name because that is what the runtime's rows are keyed by: a grounded
 * column and a derived value's accessor both land on the row under the field's
 * name, and it is also what a person writing "Invoice {number}" types.
 */
function printableValues(
	entity: SpecSystem['data']['entities'][number],
): Map<string, DocumentFieldPlan & { id: string }> {
	const out = new Map<string, DocumentFieldPlan & { id: string }>()
	for (const field of getAcceptedOrAll(entity.fields)) {
		// `json` and `file` are refused by the validator, so anything that reaches
		// here and is not printable came from a spec that skipped it. Skipping it
		// again is the honest answer: it grounds to no template rather than to a
		// template that prints punctuation.
		if (!['string', 'number', 'boolean', 'date', 'enum'].includes(field.type))
			continue
		out.set(field.name, {
			id: field.id,
			column: field.name,
			label: field.name,
			type: field.type as DocumentFieldPlan['type'],
			options: field.options
				? Object.fromEntries(field.options.map((o) => [o.value, o.label]))
				: undefined,
		})
	}
	// A computed value is arithmetic and a rollup is an aggregate, so both print
	// as numbers — and including them is why this layer ships no arithmetic: an
	// invoice total is a rollup that already exists.
	for (const derived of [
		...getAcceptedOrAll(entity.computed ?? []),
		...getAcceptedOrAll(entity.rollups ?? []),
	])
		out.set(derived.name, {
			id: derived.id,
			column: derived.name,
			label: derived.name,
			type: 'number',
		})
	return out
}

/**
 * Ground an entity's declared document templates: field *ids*
 * resolved to column names, and the theme resolved to a style.
 *
 * A template whose section names a field that is not on the accepted entity does
 * not ground **at all** — the same honest failure `groundSearch` makes, and for
 * a sharper reason. A partially-grounded template renders a document with a
 * blank where a value should be, and a document with a blank where a value
 * should be is one somebody sends to a customer. The validator has already
 * refused that spec; this is the belt for a field soft-rejected after the
 * template was declared.
 */
function groundDocuments(
	spec: SpecSystem,
	entities: SpecEntities,
	entity: SpecSystem['data']['entities'][number],
): DocumentPlan[] | undefined {
	const templates = documentTemplatesFor(spec, entity.id)
	if (templates.length === 0) return undefined
	const style = groundDocumentStyle(spec)
	const own = printableValues(entity)
	const byId = new Map([...own.values()].map((v) => [v.id, v] as const))

	const plans: DocumentPlan[] = []
	for (const template of templates) {
		const sections: DocumentSectionPlan[] = []
		let dropped = false
		for (const section of template.sections) {
			if (dropped) break
			switch (section.kind) {
				case 'heading':
					sections.push({
						kind: 'heading',
						level: section.level,
						text: section.text,
					})
					break
				case 'text':
					sections.push({ kind: 'text', text: section.text })
					break
				case 'rule':
					sections.push({ kind: 'rule' })
					break
				case 'slot':
					sections.push({ kind: 'slot', name: section.name })
					break
				case 'fields': {
					const fields = resolveFieldPlans(section.fieldIds, byId)
					if (!fields) {
						dropped = true
						break
					}
					sections.push({
						kind: 'fields',
						columns: section.columns,
						caption: section.caption,
						fields,
					})
					break
				}
				case 'table': {
					const over = entities.find((e) => e.id === section.over)
					const via = over?.fields.find((f) => f.id === section.via)
					if (!over || !via) {
						dropped = true
						break
					}
					const overById = new Map(
						[...printableValues(over).values()].map((v) => [v.id, v] as const),
					)
					const fields = resolveFieldPlans(section.fieldIds, overById)
					if (!fields) {
						dropped = true
						break
					}
					const orderBy = section.orderBy
						? over.fields.find((f) => f.id === section.orderBy)?.name
						: undefined
					sections.push({
						kind: 'table',
						caption: section.caption,
						resource: resourceName(over.id),
						via: via.name,
						orderBy,
						direction: section.direction ?? 'asc',
						fields,
					})
					break
				}
			}
		}
		if (dropped) continue
		plans.push({
			key: template.key,
			description: template.description,
			resource: resourceName(entity.id),
			pageSize: template.pageSize,
			style,
			// The declaration decides whether this template has a URL at all
			//. It used to be dropped here, so `delivery.download:
			// false` retired a template from the exposure report and from nothing
			// else — the route kept serving it.
			download: template.delivery.download,
			sections,
			values: Object.fromEntries(
				[...own].map(([name, value]) => [
					name,
					{
						column: value.column,
						label: value.label,
						type: value.type,
						options: value.options,
					},
				]),
			),
		})
	}
	return plans.length > 0 ? plans : undefined
}

/**
 * Ground an entity's declared importers: field *ids* resolved to
 * column *names*, in declaration order.
 *
 * An importer whose mapping names a field that is not on the accepted entity
 * does not ground **at all** — the same honest failure `groundSearch` and
 * `groundDocuments` make, and here the reason is the strongest of the three: a
 * partially-grounded importer would silently drop a column from the mapping, and
 * a dropped column on an upserting run overwrites existing values with nothing.
 * The validator has already refused that spec; this is the belt for a field
 * soft-rejected after the importer was declared.
 *
 * A grounded importer whose upsert key did not survive is dropped for the same
 * reason rather than quietly demoted to insert-only: silently changing *which
 * rows a run writes* is exactly the class of surprise this primitive exists to
 * prevent.
 */
function groundImporters(
	spec: SpecSystem,
	entity: SpecSystem['data']['entities'][number],
): ImportPlanShape[] | undefined {
	const declared = importersFor(spec, entity.id)
	if (declared.length === 0) return undefined
	const byId = new Map(
		getAcceptedOrAll(entity.fields).map(
			(f) => [f.id, { name: f.name, type: f.type }] as const,
		),
	)
	const plans: ImportPlanShape[] = []
	for (const importer of declared) {
		const columns: ImportPlanShape['columns'] = []
		let dropped = false
		for (const column of importer.columns) {
			const field = byId.get(column.fieldId)
			if (!field) {
				dropped = true
				break
			}
			columns.push({
				column: column.column,
				field: field.name,
				// `file` is refused at declare time, so every surviving type is one of
				// the six importable ones; the cast records that rather than widening
				// the runtime's type to accommodate a shape the validator forbids.
				type: field.type as ImportValueType,
			})
		}
		if (dropped || columns.length === 0) continue
		const upsert =
			importer.upsertFieldId === null
				? null
				: (byId.get(importer.upsertFieldId)?.name ?? undefined)
		if (upsert === undefined) continue
		plans.push({
			key: importer.key,
			description: importer.description,
			format: importer.format,
			resource: resourceName(entity.id),
			...(importer.parserSlot ? { parserSlot: importer.parserSlot } : {}),
			columns,
			upsertColumn: upsert,
			maxRows: importer.maxRows,
			paused: importer.paused,
		})
	}
	return plans.length > 0 ? plans : undefined
}

/**
 * Ground an entity's declared portals: field *ids* resolved to
 * column *names*, in declaration order.
 *
 * **A portal whose projection names a field that is not on the accepted entity
 * does not ground at all.** That is the same honest failure `groundSearch`,
 * `groundDocuments` and `groundImporters` make, and here it is the only
 * defensible one: a partially-grounded portal would be a public surface missing
 * a column somebody declared, which reads as a bug and gets "fixed" by widening
 * something. The validator has already refused such a spec; this is the belt for
 * a field soft-rejected *after* the portal was declared.
 *
 * The same rule applies to the bound and to every write allowlist, and dropping
 * on a missing **bound** matters most: a collection portal whose filter column
 * vanished would otherwise ground as an unbounded portal, which is precisely the
 * thing this layer is built to make unspellable.
 *
 * Only *accepted* portals ground (`activePortals`' rule, which is deliberately
 * accepted-**only** rather than accepted-else-all), and paused ones ground too —
 * with `paused: true` — so `portalIdentity` refuses them and the workbench can
 * still show them. Grounding the pause state rather than dropping the plan keeps
 * regeneration a function of the declaration: pausing a portal must not rewrite
 * the app.
 */
function groundPortals(
	spec: SpecSystem,
	entity: SpecSystem['data']['entities'][number],
): PortalPlan[] | undefined {
	const declared = portalsFor(spec, entity.id).filter(
		(p) => p.provenance.isAccepted === true,
	)
	if (declared.length === 0) return undefined
	const byId = new Map(
		getAcceptedOrAll(entity.fields).map((f) => [f.id, f.name] as const),
	)
	/** Column names for a list of field ids, or `null` if any one is missing. */
	const columns = (ids: readonly string[]): string[] | null => {
		const out: string[] = []
		for (const id of ids) {
			const column = byId.get(id as (typeof entity.fields)[number]['id'])
			if (!column) return null
			out.push(column)
		}
		return out
	}

	const plans: PortalPlan[] = []
	for (const portal of declared) {
		const readFields = columns(portal.readFields)
		if (!readFields || readFields.length === 0) continue
		let bound: PortalPlan['filter']
		if (portal.filter) {
			const field = byId.get(portal.filter.fieldId)
			if (!field) continue
			bound = { field, equals: portal.filter.equals }
		} else if (portal.scope === 'collection') continue
		const writes: PortalPlan['writes'] = []
		let dropped = false
		for (const write of portal.writes) {
			const fields = columns(write.fieldIds)
			if (!fields) {
				dropped = true
				break
			}
			writes.push({
				action: write.action,
				fields,
				rateLimitPerHour: write.rateLimitPerHour,
			})
		}
		if (dropped) continue
		const exposed = new Set(readFields)
		const titleField = pickTitleField(
			getAcceptedOrAll(entity.fields).filter((f) => exposed.has(f.name)),
		)
		plans.push({
			key: portal.key,
			description: portal.description,
			resource: resourceName(entity.id),
			audience: portal.audience,
			...(portal.role ? { role: portal.role } : {}),
			...(portal.token ? { token: portal.token } : {}),
			scope: portal.scope,
			readFields,
			// Picked over the EXPOSED columns only. Picking over the entity's full
			// field list would let a column the portal deliberately withholds title
			// a public page — a projection leak through the one surface strangers
			// scrape and cache.
			...(titleField ? { titleField } : {}),
			writes,
			...(bound ? { filter: bound } : {}),
			layout: portal.layout,
			paused: portal.paused,
		})
	}
	return plans.length > 0 ? plans : undefined
}

/**
 * Ground an entity's declared live channels: field *ids* resolved
 * to column *names*, in declaration order.
 *
 * **A channel whose projection names a field that is not on the accepted entity
 * does not ground at all**, which is the same honest failure `groundSearch`,
 * `groundDocuments`, `groundImporters` and `groundPortals` make. A
 * partially-grounded channel would push a row missing a column somebody
 * declared, which reads as a bug and gets "fixed" by widening something. The
 * same rule applies to a `filtered` bound, and dropping on a missing bound
 * matters most: a channel whose filter column vanished would otherwise ground as
 * an unbounded one, which is precisely what the declaration exists to prevent.
 *
 * Every *accepted* channel grounds, paused ones included — with `paused: true`,
 * so `LiveChannel.subscribe` refuses them and the surface polls instead.
 * Grounding the pause state rather than dropping the plan keeps regeneration a
 * function of the declaration: pausing a channel at 3am must not rewrite the
 * app.
 *
 * Unlike `groundPortals` this uses the ordinary accepted-else-all view rather
 * than accepted-only, matching `activeLiveSubscriptions` — see its comment. A
 * suggested portal that grounded would put a table on the internet; a suggested
 * channel reaches nobody a read op would not already reach.
 */
function groundLive(
	spec: SpecSystem,
	entity: SpecSystem['data']['entities'][number],
): LivePlan[] | undefined {
	const declared = getAcceptedOrAll(listLiveSubscriptions(spec)).filter(
		(l) => l.entityId === entity.id,
	)
	if (declared.length === 0) return undefined
	const byId = new Map(
		getAcceptedOrAll(entity.fields).map((f) => [f.id, f.name] as const),
	)
	const plans: LivePlan[] = []
	for (const sub of declared) {
		const fields: string[] = []
		let dropped = false
		for (const id of sub.fields) {
			const column = byId.get(id)
			if (!column) {
				dropped = true
				break
			}
			fields.push(column)
		}
		if (dropped) continue
		let scope: LivePlan['scope']
		if (sub.scope.kind === 'filtered') {
			const field = byId.get(sub.scope.fieldId)
			if (!field) continue
			scope = { kind: 'filtered', field }
		} else {
			scope = { kind: sub.scope.kind }
		}
		plans.push({
			key: sub.key,
			description: sub.description,
			resource: resourceName(entity.id),
			kind: sub.kind,
			fields,
			scope,
			maxSubscribers: sub.maxSubscribers,
			maxMessagesPerMinute: sub.maxMessagesPerMinute,
			...(sub.presenceTtlSeconds !== undefined
				? { presenceTtlSeconds: sub.presenceTtlSeconds }
				: {}),
			...(sub.maxPresent !== undefined ? { maxPresent: sub.maxPresent } : {}),
			slot: sub.slot,
			paused: sub.paused,
		})
	}
	return plans.length > 0 ? plans : undefined
}

/** Field ids → grounded plans, or `undefined` when any one of them is missing. */
function resolveFieldPlans(
	ids: readonly string[],
	byId: ReadonlyMap<string, DocumentFieldPlan & { id: string }>,
): DocumentFieldPlan[] | undefined {
	const out: DocumentFieldPlan[] = []
	for (const id of ids) {
		const value = byId.get(id)
		if (!value) return undefined
		out.push({
			column: value.column,
			label: value.label,
			type: value.type,
			options: value.options,
		})
	}
	return out
}

/**
 * Ground an entity's declared list actions: field *ids* resolved to column
 * *names*, in declaration order.
 *
 * **An action whose write names a field that is not on the accepted entity does
 * not ground at all** — the same honest failure `groundSearch`,
 * `groundDocuments`, `groundImporters` and `groundPortals` make, and here the
 * reason is the sharpest of the five: a partially-grounded action would be a
 * button that writes *some* of what was declared, over as many rows as the cap
 * allows. "Close and unassign these" silently becoming "close these" is a
 * fourteen-row surprise nobody reviewed.
 *
 * The chosen field is dropped the same way, and dropping it drops the whole
 * action rather than demoting it to its fixed half: an action whose declared
 * `set` is empty would otherwise ground as a button that writes nothing.
 *
 * Only *accepted* actions ground (`activeActions`' rule, which is deliberately
 * accepted-**only** rather than accepted-else-all): an agent's unreviewed
 * suggestion must not appear in an end user's toolbar with the power to rewrite
 * five hundred rows.
 */
function groundActions(
	spec: SpecSystem,
	entity: SpecSystem['data']['entities'][number],
): ActionPlan[] | undefined {
	// Every accepted action over this entity, at any arity: grounding produces the
	// registry plan, and which surface offers a button is the surface's question.
	const declared = activeActions(spec).filter((a) => a.entityId === entity.id)
	if (declared.length === 0) return undefined
	const fields = getAcceptedOrAll(entity.fields)
	const byId = new Map(fields.map((f) => [f.id as string, f] as const))

	const plans: ActionPlan[] = []
	for (const action of declared) {
		const set: ActionPlan['set'] = {}
		let dropped = false
		for (const [fieldId, value] of Object.entries(action.effect.set)) {
			const field = byId.get(fieldId)
			if (!field) {
				dropped = true
				break
			}
			set[field.name] = value
		}
		if (dropped) continue
		let choose: ActionPlan['choose']
		if (action.effect.choose) {
			const field = byId.get(action.effect.choose)
			// The options travel with the column, so the check that a run's value is
			// one of them happens below every surface. A plan carrying the column
			// alone would push that check back onto whoever built the request.
			const options = field?.options?.map((o) => o.value) ?? []
			if (!field || options.length === 0) continue
			choose = { column: field.name, options }
		}
		if (Object.keys(set).length === 0 && !choose) continue
		plans.push({
			key: action.key,
			label: action.label,
			description: action.description,
			arity: action.arity,
			set,
			...(choose ? { choose } : {}),
			...(action.role ? { role: action.role } : {}),
			maxSelection: action.maxSelection,
			undoable: action.undoable,
		})
	}
	return plans.length > 0 ? plans : undefined
}

export function groundedEntityShapes(
	spec: SpecSystem,
	options: GroundingOptions = {},
): SpecEntityShape[] {
	// Resolve references against the *whole* entity set (accepted or all), not
	// just the accepted subset, so a reference target that is still `suggested`
	// still resolves — grounding and reference-resolution use the same view.
	const entities = getAcceptedOrAll(spec.data.entities)
	return entities.map((entity) => {
		const search = groundSearch(spec, entity)
		const documents = groundDocuments(spec, entities, entity)
		const importers = groundImporters(spec, entity)
		const portals = groundPortals(spec, entity)
		const live = groundLive(spec, entity)
		const actions = groundActions(spec, entity)
		return {
			name: resourceName(entity.id),
			description: entity.description,
			fields: getAcceptedOrAll(entity.fields).map((field) => ({
				name: field.name,
				type: field.type,
				required: field.required,
				options: field.options,
				// A file field's declaration travels verbatim: the
				// allowlist and cap the upload path enforces are the spec's, not the
				// app's. Only carried for `type: 'file'` — the op validator refuses the
				// combination anywhere else, and grounding is not the place to
				// re-litigate it.
				file: field.type === 'file' ? field.file : undefined,
				// A manual-ordering key and a column's per-value caps are
				// *data* declarations, so they ground like any other: the rank flag makes
				// the column non-null with a database default, and the caps become the
				// `meta.valueLimits` that `opCreate`/`opUpdate` enforce. Dropping either
				// here would leave the board drawing a limit nothing checks.
				rank: field.rank,
				limits: field.limits,
				// A number field's declared presentation and scale (#345) —
				// grounded like any other data declaration, since the widget an author
				// asked for is not a fact the runtime is free to re-derive. Dropping it
				// here would leave `data.setFieldDisplay` writing to a spec nothing reads.
				display: field.display,
				// A field's declared filter control (#414) — grounded for the
				// same reason `display` is: the control an author asked for (or asked
				// *not* to have) is not a fact the runtime may re-derive. Dropping it
				// here would leave `data.setFieldFilter` writing to a spec nothing
				// reads, and REST would keep honouring a filter the spec refuses.
				filter: field.filter,
				reference: field.reference
					? groundReference(entities, field.reference, options.installedBundles)
					: undefined,
			})),
			// Derived values. Omitted entirely when empty so a spec with
			// no rollups grounds to exactly the shape it did before.
			...(entity.computed?.length ? { computed: groundComputed(entity) } : {}),
			...(entity.rollups?.length
				? { rollups: groundRollups(entities, entity) }
				: {}),
			// A declared search index. Like `computed`/`rollups` it adds
			// no column, and it is omitted entirely when absent so a spec that declares
			// none grounds to exactly the shape it did before. It must be threaded here
			// *and* be part of the schema fingerprint, which it is for free: the
			// fingerprint hashes these shapes, so flipping `indexed` re-grounds and the
			// CREATE/DROP INDEX actually runs.
			...(search ? { search } : {}),
			// Declared document templates. Omitted when absent on the
			// same rule, and it contributes no DDL at all — a document is a rendering
			// of rows that already exist. It still belongs in the fingerprint, which
			// it gets for free: changing a template re-grounds, and the registry the
			// document route reads is rebuilt.
			...(documents ? { documents } : {}),
			// Declared importers. Omitted when absent on the same rule,
			// and it contributes no DDL at all — an importer is a declared way *in*
			// to rows that already have a shape. Threading it here is what puts
			// `planImport`/`opApplyImport` at the depth `authorize()` runs at; drop it
			// and the upload route would have nothing to look up, which is the
			// failure mode that ends with somebody writing rows around the gate.
			...(importers ? { importers } : {}),
			// Declared portals. Omitted when absent on the same rule,
			// and the absence is the load-bearing case: an entity with no portals is
			// an entity with no outside. Threading it here is what puts the
			// projection and the bound at the depth `authorize()` runs at — and what
			// makes `accessWithPortals` in `from-spec.ts` able to reconcile the
			// declaration with the deployment's write posture instead of a route
			// quietly deciding to skip it.
			...(portals ? { portals } : {}),
			// Declared live channels. Omitted when absent on the same
			// rule, and the absence means the honest thing: every derived surface on
			// this entity is a snapshot and nothing holds a connection open.
			// Threading it here is what lets the SSE route find a plan; the gate is
			// already below it, so a dropped plan costs liveness rather than safety —
			// which is the correct direction for the one declaration in this file
			// whose failure mode is a slow app rather than an open one.
			...(live ? { live } : {}),
			// Declared list actions. Omitted when absent on the same rule, and the
			// absence carries `portals`' weight rather than `live`'s: an entity with
			// no actions has no way to change many rows at once, and that is a
			// security fact about the app rather than a missing convenience.
			// Threading it here is what puts the cap, the role and the write set at
			// the depth `authorize()` runs at — drop it and the toolbar would have
			// nothing to look up, which is the failure mode that ends with somebody
			// writing a loop around the gate.
			...(actions ? { actions } : {}),
		}
	})
}

/**
 * The bundles that virtual-entity references need but that are not installed —
 * those references ground as plain columns (no picker, no resolution) until
 * `maxstack add <bundle>` runs. The server warns with this list.
 */
export function missingReferenceBundles(
	spec: SpecSystem,
	installedBundles: readonly string[],
): string[] {
	const entities = getAcceptedOrAll(spec.data.entities)
	const missing = new Set<string>()
	for (const entity of entities) {
		for (const field of getAcceptedOrAll(entity.fields)) {
			if (!field.reference) continue
			if (entities.some((e) => e.id === field.reference)) continue
			const virtual = virtualEntity(field.reference)
			if (virtual && !installedBundles.includes(virtual.bundle))
				missing.add(virtual.bundle)
		}
	}
	return [...missing]
}

/** Stable identity of the grounded schema — when it changes, re-sync the DB. */
export function schemaFingerprint(shapes: readonly SpecEntityShape[]): string {
	return JSON.stringify(shapes)
}
