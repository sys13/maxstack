/**
 * Derived blast radius.
 *
 * A reviewer deciding on `data.addField` is not deciding about a line in a JSON
 * document. They are deciding whether a column appears in a table, whether a
 * form grows an input, whether a REST endpoint starts accepting a new key, and —
 * the one that actually matters — whether a value becomes readable by the public
 * internet. A spec diff shows none of that. It under-describes the blast radius,
 * and blast radius is the entire thing being decided on.
 *
 * So this derives the **surfaces a spec produces**, and diffs that inventory
 * between two specs. The op stays the input; the consequences are the output.
 *
 * ## Why it lives here
 *
 * In `@maxstack/mcp`, which imports core and spec and nothing else, because all
 * three hosts have to give the same answer: the workbench pane, `maxstack
 * blast-radius`, and the MCP tool. #199 taught this the hard way — the same
 * project reported different batchability in the terminal and the browser purely
 * because one host had been taught to read something the other had not, and a
 * model that gives two answers is one a reviewer routes around.
 *
 * ## The accepted-or-all rule, and why it is stated rather than hidden
 *
 * Grounding runs over {@link getAcceptedOrAll}: accepted rows if any are
 * accepted, otherwise all of them. This derivation uses the same rule, because
 * the question is "what will the runtime build", not "what would a reasonable
 * runtime build".
 *
 * That has a consequence which looks like a bug and is not. While **nothing in a
 * collection** is accepted, every suggested row in it is already grounded, so
 * accepting one changes no derived surface at all — the honest report is "no
 * change to what gets built". Once one row there is accepted, the rest stop being
 * built until they are accepted too, and the same op suddenly adds a column.
 *
 * Per *collection*, not per spec: an accepted entity whose fields are all still
 * suggested has its fields in fallback while its entity list is not. Getting that
 * wrong made the explanation vanish at exactly the moment it was most needed, on a
 * real project. A reviewer shown an empty diff with no explanation would reasonably
 * conclude the op was inert, so {@link blastRadius} carries `groundingNote`, it
 * names which collections are in that state, and every surface renders it.
 *
 * ## What this deliberately does not do
 *
 * It does not run the generators. Emitting code for two specs and diffing the
 * output would be slower, would answer at file granularity ("routes.ts
 * changed"), and would make the reviewer read a diff to find the fact. The
 * inventory is a set of *named consequences* instead: "the `orders` table gains
 * a `total` column", "`/api/orders` accepts `total` on write".
 */

import {
	activePortals,
	type FieldSpec,
	getAcceptedOrAll,
	listPortals,
	portalExposureReport,
	type SpecSystem,
} from '@maxstack/spec'

// ===========================================================================
// The inventory
// ===========================================================================

/**
 * The kinds of thing a spec produces, ordered by how much a reviewer should care.
 *
 * The order is the *sort* order in every surface, and it is a claim: a field
 * becoming publicly readable outranks a table gaining a column, which outranks a
 * new MCP tool name. A list sorted by artifact type instead would bury the one
 * item this whole surface exists to show.
 */
export const SURFACE_KINDS = [
	'public-field',
	'public-write',
	'table',
	'column',
	'route',
	'form',
	'rest',
	'tool',
] as const

export type SurfaceKind = (typeof SURFACE_KINDS)[number]

/** One thing a spec produces. */
export interface DerivedSurface {
	kind: SurfaceKind
	/** Stable identity, so the same surface in two specs compares equal. */
	id: string
	/** A sentence a reviewer can read without knowing the vocabulary. */
	label: string
	/**
	 * The part that can change while the identity stays the same — a column's
	 * type, a form's field list. `null` when the surface has no varying detail,
	 * which keeps "changed" from firing on surfaces that cannot change.
	 */
	detail: string | null
}

const RESOURCE_PREFIX = /^e-/

/**
 * An entity id's resource name — `e-order` → `order`.
 *
 * This rule is owned by the runtime's grounding (`resourceName` in
 * `spec-sprout.ts`) and repeated here because this package may not import the
 * app. That duplication is pinned by an agreement test in `apps/web` that
 * asserts these names equal `groundedEntityShapes()`'s, in the same way the
 * spec↔features SSRF check is pinned. A silently diverging table name
 * would make every blast-radius report subtly wrong about which table it meant.
 */
function resourceName(entityId: string): string {
	return entityId.replace(RESOURCE_PREFIX, '')
}

/** The columns a field produces. One, always — but named through one function. */
function columnName(field: FieldSpec): string {
	return field.name
}

/**
 * Every field a **live** portal publishes, and how — built on
 * {@link portalExposureReport}.
 *
 * Built on it rather than beside it, and that is not a style preference. That
 * function's own docblock states the rule: "two implementations of a security
 * boundary is one more than is safe", and it is the implementation pinned by the
 * agreement test that asserts a portal response's keys equal exactly the fields it
 * reports as readable. A second walk of `readFields`/`writes` here would be the
 * second implementation — subtly divergent, and wrong in the direction that
 * under-reports exposure.
 *
 * What this adds is the one question `portalExposureReport` deliberately does not
 * answer: **liveness**. That report covers every *declared* portal, paused ones
 * included, because it answers "what could be exposed". A blast radius needs "what
 * is exposed right now", so the rows are filtered to {@link activePortals} —
 * accepted, not paused.
 *
 * That filter is what makes the diff work on the transition that matters. A
 * proposed or paused portal publishes nothing in the `before` spec; the moment it
 * is accepted or un-paused, every field it names shows up as newly public.
 */
function livePublicFields(spec: SpecSystem): {
	readable: Map<string, string>
	writable: Map<string, string>
} {
	const live = new Set(activePortals(spec).map((p) => p.id))
	const readable = new Map<string, string>()
	const writable = new Map<string, string>()
	for (const row of portalExposureReport(spec)) {
		if (!live.has(row.portalId)) continue
		const target = row.access === 'read' ? readable : writable
		target.set(`${row.entityId}:${row.fieldId}`, row.portalKey)
	}
	return { readable, writable }
}

/**
 * Exposure that is declared but not currently live: suggested, or paused.
 *
 * Not part of the diff — it is a standing fact, not a change — but reported
 * alongside it, because "one op away from being public" is something a reviewer
 * looking at a public boundary needs to see. A paused portal reads as safe right
 * up until somebody un-pauses it, and un-pausing takes no review at all.
 */
export function latentExposure(
	spec: SpecSystem,
): { key: string; entityId: string; fields: number; reason: string }[] {
	const live = new Set(activePortals(spec).map((p) => p.id))
	return listPortals(spec)
		.filter((p) => !live.has(p.id))
		.map((p) => ({
			key: p.key,
			entityId: p.entityId,
			// Read fields plus write fields: a portal that only accepts writes still
			// puts a column on the internet, in the direction that creates rows.
			fields: portalExposureReport({ portals: { portals: [p] } }).length,
			reason: p.paused
				? 'paused — un-pausing publishes it again with no further review'
				: 'declared but not accepted — accepting it makes these fields public',
		}))
}

/**
 * The whole inventory of surfaces `spec` produces.
 *
 * Over `getAcceptedOrAll`, matching what the runtime actually grounds — see the
 * module note on why that rule is load-bearing rather than incidental.
 */
export function deriveSurfaces(spec: SpecSystem): DerivedSurface[] {
	const out: DerivedSurface[] = []
	const entities = getAcceptedOrAll(spec.data.entities)
	const exposure = livePublicFields(spec)

	for (const entity of entities) {
		const resource = resourceName(entity.id)
		const fields = getAcceptedOrAll(entity.fields)

		out.push({
			kind: 'table',
			id: `table:${resource}`,
			label: `the \`${resource}\` table`,
			detail: `${fields.length} column${fields.length === 1 ? '' : 's'}`,
		})
		out.push({
			kind: 'rest',
			id: `rest:${resource}`,
			label: `\`/api/${resource}\` (list, create, update, delete)`,
			detail: fields.map(columnName).sort().join(', '),
		})
		// The per-resource CRUD tools an agent sees. Named because "what can an
		// agent now do to my data" is a review question, and the answer changes
		// without any UI changing.
		out.push({
			kind: 'tool',
			id: `tool:${resource}`,
			label: `MCP: \`${resource}\` reachable by \`list_records\` / \`create_record\` / …`,
			detail: null,
		})

		for (const field of fields) {
			out.push({
				kind: 'column',
				id: `column:${resource}.${columnName(field)}`,
				label: `\`${resource}.${columnName(field)}\``,
				detail: `${field.type}${field.required ? ', required' : ''}`,
			})
			if (exposure.readable.has(`${entity.id}:${field.id}`)) {
				out.push({
					kind: 'public-field',
					id: `public-field:${resource}.${columnName(field)}`,
					label: `**\`${resource}.${columnName(field)}\` is readable by the public internet**`,
					detail: `via the \`${exposure.readable.get(`${entity.id}:${field.id}`)}\` portal`,
				})
			}
			if (exposure.writable.has(`${entity.id}:${field.id}`)) {
				out.push({
					kind: 'public-write',
					id: `public-write:${resource}.${columnName(field)}`,
					label: `**\`${resource}.${columnName(field)}\` is writable by the public internet**`,
					detail: `via the \`${exposure.writable.get(`${entity.id}:${field.id}`)}\` portal`,
				})
			}
		}
	}

	for (const page of getAcceptedOrAll(spec.pages.pages)) {
		out.push({
			kind: 'route',
			id: `route:${page.route}`,
			label: `the \`${page.route}\` route`,
			detail: page.name,
		})
		for (const block of getAcceptedOrAll(page.blocks)) {
			if (block.type !== 'form') continue
			const entity = entities.find((e) => e.id === page.entityId)
			const inputs = entity
				? getAcceptedOrAll(entity.fields).map(columnName).sort()
				: []
			out.push({
				kind: 'form',
				id: `form:${page.route}:${block.id}`,
				label: `the form on \`${page.route}\``,
				detail: inputs.join(', '),
			})
		}
	}

	return out
}

// ===========================================================================
// The diff
// ===========================================================================

/** A surface whose identity survived but whose shape did not. */
export interface SurfaceChange {
	surface: DerivedSurface
	before: string | null
	after: string | null
}

export interface BlastRadius {
	added: DerivedSurface[]
	/**
	 * Surfaces that stop existing. Listed separately and *first* among the
	 * structural kinds because this is the direction that destroys things: a
	 * column that disappears is data that disappears, and no amount of "it was
	 * only a spec edit" changes that.
	 */
	removed: DerivedSurface[]
	changed: SurfaceChange[]
	/** How many surfaces were untouched — the denominator for "how big is this". */
	unchanged: number
	/** One sentence naming the whole effect, worst-first. */
	summary: string
	/**
	 * Set when the derivation could not see a difference *because of the
	 * accepted-or-all rule*, not because the op is inert. See the module note.
	 */
	groundingNote: string | null
	/** True when anything crosses the public boundary — the one flag worth gating on. */
	touchesPublic: boolean
}

const KIND_RANK = new Map<SurfaceKind, number>(
	SURFACE_KINDS.map((kind, i) => [kind, i]),
)

function bySeverity(a: DerivedSurface, b: DerivedSurface): number {
	const rank = (KIND_RANK.get(a.kind) ?? 99) - (KIND_RANK.get(b.kind) ?? 99)
	return rank !== 0 ? rank : a.id.localeCompare(b.id)
}

/** Is anything accepted anywhere? Decides whether the grounding note applies. */
/**
 * The collections currently in accepted-or-all **fallback** — nothing in them is
 * accepted, so every suggested member is already being built and accepting one
 * changes nothing.
 *
 * Per collection, not per spec, and that distinction was a real bug: the first
 * version asked "is anything accepted anywhere", so a project with one accepted
 * *entity* whose fields were all suggested reported an unexplained empty diff for
 * every field acceptance. Driving `maxstack review` on a real project is what
 * surfaced it — the note vanished at exactly the moment it was most needed.
 *
 * `getAcceptedOrAll` is applied to each list independently, so the fallback state
 * is per list too. Named rather than counted, because "which part of my project is
 * in this state" is the actionable half.
 */
function fallbackCollections(spec: SpecSystem): string[] {
	const anyAccepted = (
		items: readonly { provenance: { isAccepted: boolean | null } }[],
	) => items.some((i) => i.provenance.isAccepted === true)

	const out: string[] = []
	if (spec.data.entities.length > 0 && !anyAccepted(spec.data.entities)) {
		out.push('entities')
	}
	for (const entity of spec.data.entities) {
		if (entity.fields.length > 0 && !anyAccepted(entity.fields)) {
			out.push(`fields on ${resourceName(entity.id)}`)
		}
	}
	if (spec.pages.pages.length > 0 && !anyAccepted(spec.pages.pages)) {
		out.push('pages')
	}
	for (const page of spec.pages.pages) {
		if (page.blocks.length > 0 && !anyAccepted(page.blocks)) {
			out.push(`blocks on ${page.route}`)
		}
	}
	return out
}

/**
 * What changes about the built application between two specs.
 *
 * `after` is normally a *hypothetical* spec — the current one with a pending op
 * applied in memory and never saved. That is the whole point: the reviewer sees
 * the consequences before consenting to them.
 */
export function blastRadius(
	before: SpecSystem,
	after: SpecSystem,
): BlastRadius {
	const beforeById = new Map(deriveSurfaces(before).map((s) => [s.id, s]))
	const afterById = new Map(deriveSurfaces(after).map((s) => [s.id, s]))

	const added: DerivedSurface[] = []
	const removed: DerivedSurface[] = []
	const changed: SurfaceChange[] = []
	let unchanged = 0

	for (const [id, surface] of afterById) {
		const was = beforeById.get(id)
		if (!was) {
			added.push(surface)
		} else if (was.detail !== surface.detail) {
			changed.push({ surface, before: was.detail, after: surface.detail })
		} else {
			unchanged++
		}
	}
	for (const [id, surface] of beforeById) {
		if (!afterById.has(id)) removed.push(surface)
	}

	added.sort(bySeverity)
	removed.sort(bySeverity)
	changed.sort((a, b) => bySeverity(a.surface, b.surface))

	const touchesPublic = [
		...added,
		...removed,
		...changed.map((c) => c.surface),
	].some((s) => s.kind === 'public-field' || s.kind === 'public-write')

	const nothing = added.length + removed.length + changed.length === 0
	const fallbacks = nothing ? fallbackCollections(before) : []
	const groundingNote =
		fallbacks.length > 0
			? `No derived change — but only because nothing is accepted yet in: ${fallbacks.join('; ')}. While a collection is in that state every suggested row is already being built, so accepting one changes nothing. Once one row there is accepted, the rest stop being built until they are accepted too.`
			: null

	return {
		added,
		removed,
		changed,
		unchanged,
		summary: describeBlastRadius({
			added,
			removed,
			changed,
			touchesPublic,
		}),
		groundingNote,
		touchesPublic,
	}
}

/**
 * One sentence for the whole effect, worst thing first.
 *
 * Deliberately leads with public exposure and with removals — the two facts a
 * reviewer would most regret skimming past — rather than with counts in
 * declaration order.
 */
export function describeBlastRadius(radius: {
	added: readonly DerivedSurface[]
	removed: readonly DerivedSurface[]
	changed: readonly { surface: DerivedSurface }[]
	touchesPublic: boolean
}): string {
	const parts: string[] = []
	if (radius.touchesPublic) {
		const n = [
			...radius.added,
			...radius.removed,
			...radius.changed.map((c) => c.surface),
		].filter(
			(s) => s.kind === 'public-field' || s.kind === 'public-write',
		).length
		parts.push(
			`changes public exposure (${n} field${n === 1 ? '' : 's'} across the public boundary)`,
		)
	}
	if (radius.removed.length > 0) {
		parts.push(
			`REMOVES ${radius.removed.length} derived surface${radius.removed.length === 1 ? '' : 's'}`,
		)
	}
	if (radius.added.length > 0) parts.push(`adds ${radius.added.length}`)
	if (radius.changed.length > 0) parts.push(`changes ${radius.changed.length}`)
	if (parts.length === 0) return 'no change to what gets built'
	return parts.join('; ')
}

// ===========================================================================
// The app-shaped answer on the apply path
// ===========================================================================

/**
 * How much of an op's effect this inventory can see.
 *
 * The distinction is the whole point. `blastRadius` diffs tables, columns,
 * routes, forms, REST payloads, MCP tools and public fields — a real inventory,
 * but not a total one. Reporting "no change to what gets built" for an op whose
 * layer this inventory does not model would be a false all-clear, and a false
 * all-clear on the mutation path is worse than the silence issue #263 opened
 * about: silence at least does not claim anything.
 *
 *   - `modelled` — the op's layer is inside the inventory, so an empty diff is a
 *     genuine "the built application is unchanged".
 *   - `presentation` — the op retunes how an existing surface renders. The
 *     inventory tracks structure, not presentation, so it will always report an
 *     empty diff and that emptiness means nothing.
 *   - `unmodelled` — a layer with no derived surfaces here (schedules, sources,
 *     imports, flags, search, documents, live, pricing, product). No claim.
 */
export type EffectCoverage = 'modelled' | 'presentation' | 'unmodelled'

/**
 * What an op did to the **application**, next to what it did to the document.
 *
 * Compact by construction: labels rather than full surfaces, capped, because
 * this rides on every mutation reply and a reply an agent skims is a reply that
 * steers nobody.
 */
export interface OpEffect {
	coverage: EffectCoverage
	/**
	 * Does the built application differ? `null` — not `false` — whenever coverage
	 * is not `modelled`, because "I cannot see" and "nothing happened" are
	 * different answers and only one of them is safe to act on.
	 */
	changesBuiltApp: boolean | null
	/** One app-shaped sentence: what a user of the built app would notice. */
	summary: string
	added: string[]
	removed: string[]
	changed: string[]
	/** Surfaces elided from the three lists above by the cap. */
	omitted: number
	touchesPublic: boolean
	/** Why the answer is what it is, when that is not self-evident. */
	note: string | null
}

/** The layers whose output `deriveSurfaces` actually enumerates. */
const MODELLED_OP_PREFIXES = ['data.', 'page.', 'portals.', 'provenance.']

/**
 * Ops that change presentation only — the inventory can never see them.
 *
 * `page.setBlockEditable` belongs here despite naming a *write* affordance
 *, and the reason is the whole design: an inline cell submits to
 * the record's existing edit route, so no table, column, route, form, REST
 * payload, MCP tool or public field appears, changes or stops existing. The
 * honest report is "the inventory is unchanged and says nothing about what a
 * user sees" — not "the built application is unchanged", which a `modelled`
 * classification would make this op claim, falsely.
 */
const PRESENTATION_OPS = new Set([
	'page.setBlockOrder',
	'page.setBlockVariant',
	'page.setBlockFields',
	'page.setBlockEditable',
	'theme.set',
])

/** How many surface labels a list names before it defers to `omitted`. */
const MAX_LABELS = 5

function coverageOf(opName: string | null): EffectCoverage {
	if (!opName) return 'unmodelled'
	if (PRESENTATION_OPS.has(opName)) return 'presentation'
	return MODELLED_OP_PREFIXES.some((p) => opName.startsWith(p))
		? 'modelled'
		: 'unmodelled'
}

const INVENTORY =
	'tables, columns, routes, forms, REST payloads, MCP tools and public fields'

/**
 * The app-shaped half of a mutation reply.
 *
 * `apply_spec_change` has always answered "what did I change in the document".
 * This answers "what changed in the running application", and — the part the
 * document-shaped diff structurally cannot express — is able to say **nothing
 * did**. That sentence is the single most useful thing the apply path can
 * return, because the moment the two answers diverge is exactly the moment the
 * caller is about to report work it did not do.
 */
export function opEffect(
	before: SpecSystem,
	after: SpecSystem,
	op: { op?: string } | null | undefined,
): OpEffect {
	const radius = blastRadius(before, after)
	const coverage = coverageOf(typeof op?.op === 'string' ? op.op : null)
	const opName = op?.op ?? 'This op'

	const all = [
		...radius.added,
		...radius.removed,
		...radius.changed.map((c) => c.surface),
	]
	const over = (n: number) => Math.max(0, n - MAX_LABELS)
	const omitted =
		over(radius.added.length) +
		over(radius.removed.length) +
		over(radius.changed.length)
	const labels = (surfaces: readonly DerivedSurface[]) =>
		surfaces.slice(0, MAX_LABELS).map((s) => s.label)
	const moved = all.length > 0

	if (coverage !== 'modelled' && !moved) {
		return {
			coverage,
			changesBuiltApp: null,
			summary:
				coverage === 'presentation'
					? `${opName} retunes how an existing surface renders — no ${INVENTORY} change, and this inventory does not model presentation, so that says nothing either way about what a user sees.`
					: `${opName} produces no ${INVENTORY}. This inventory does not model its layer, so no claim is made about whether the application changed.`,
			added: [],
			removed: [],
			changed: [],
			omitted: 0,
			touchesPublic: false,
			note:
				coverage === 'presentation'
					? 'Whether the retuned region is what actually renders depends on the owned components in front of it — a filled replace-mode slot renders instead. See `warnings`.'
					: null,
		}
	}

	return {
		coverage,
		// A modelled op that moved nothing moved nothing, full stop. An unmodelled
		// op that DID move a surface still moved it — the coverage caveat only ever
		// weakens a negative, never a positive.
		changesBuiltApp: moved,
		summary: moved
			? radius.summary
			: `${opName} applied, and the built application is unchanged: no ${INVENTORY} appear, change or stop existing.`,
		added: labels(radius.added),
		removed: labels(radius.removed),
		changed: labels(radius.changed.map((c) => c.surface)),
		omitted,
		touchesPublic: radius.touchesPublic,
		note: radius.groundingNote,
	}
}
