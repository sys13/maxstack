/**
 * Runtime validation for the whole spec system.
 *
 * The branded-id types give category safety at compile time; this closes the
 * runtime gaps the types can't — that cross-layer references actually EXIST,
 * that provenance columns are well-formed, and that the ledger entries are
 * internally consistent. It composes the product-layer `validatePRD` with
 * data/page/pricing referential checks (same discipline, one system).
 */

import { validatePRD } from '../prd/prd.schema.ts'
import { ACCESS_KEY_RE, bindingCycleErrors, roleGrantErrors } from './access.ts'
import { OP_SURFACES, opActorSchema } from './actor.ts'
import { validateLedger } from './decision-ledger.ts'
import {
	DOCUMENT_FORMATS,
	DOCUMENT_KEY_RE,
	DOCUMENT_PAGE_SIZES,
	DOCUMENT_SECTION_KINDS,
	type DocumentDelivery,
	type DocumentRecipient,
	type DocumentSection,
	type DocumentTemplateSpec,
	documentPlaceholders,
	MAX_DOCUMENT_KEY_LENGTH,
	MAX_DOCUMENT_SECTION_FIELDS,
	MAX_DOCUMENT_SECTIONS,
	MAX_DOCUMENT_TABLE_COLUMNS,
	printableFieldTypes,
} from './documents.ts'
import { FLAG_KEY_RE, MAX_ROLLOUT_PERCENT } from './flags.ts'
import type { FieldId } from './ids.ts'
import {
	IMPORT_FORMATS,
	IMPORT_KEY_RE,
	IMPORT_PARSER_SLOT_RE,
	type ImporterSpec,
	importableFieldTypes,
	MAX_IMPORT_COLUMNS,
	MAX_IMPORT_KEY_LENGTH,
	MAX_IMPORT_ROWS,
	upsertKeyFieldTypes,
} from './imports.ts'
import {
	LIVE_KEY_RE,
	LIVE_KINDS,
	LIVE_SCOPE_KINDS,
	type LiveSubscriptionSpec,
	liveScopeFieldTypes,
	MAX_LIVE_FIELDS,
	MAX_LIVE_KEY_LENGTH,
	MAX_LIVE_MESSAGE_RATE,
	MAX_LIVE_SUBSCRIBERS,
	MAX_PRESENCE_TTL_SECONDS,
	MAX_PRESENT,
	MAX_UNBOUNDED_SUBSCRIBERS,
	pushableFieldTypes,
} from './live.ts'
import {
	MAX_PORTAL_FIELDS,
	MAX_PORTAL_KEY_LENGTH,
	MAX_PORTAL_TOKEN_TTL_HOURS,
	MAX_PORTAL_WRITE_RATE,
	MAX_PUBLIC_WRITE_RATE,
	PORTAL_AUDIENCES,
	PORTAL_KEY_RE,
	PORTAL_LAYOUTS,
	PORTAL_SCOPES,
	PORTAL_WRITE_ACTIONS,
	type PortalSpec,
	portalFilterFieldTypes,
} from './portals.ts'
import { provenanceSchema } from './provenance.ts'
import {
	isValidTimezone,
	MAX_FANOUT_ORGS,
	MAX_INTERVAL_MINUTES,
	MIN_INTERVAL_MINUTES,
	SCHEDULE_KEY_RE,
	SCHEDULE_RECURRENCE_KINDS,
	SCHEDULE_RUN_AS_KINDS,
	SCHEDULE_TIME_RE,
} from './schedules.ts'
import {
	MAX_SEARCH_FIELDS,
	MAX_SEARCH_KEY_LENGTH,
	SEARCH_KEY_RE,
	SEARCH_LANGUAGES,
	SEARCH_WEIGHTS,
	type SearchIndexSpec,
	searchableFieldTypes,
} from './search.ts'
import { siteErrors } from './site.ts'
import {
	ENRICH_TRIGGER_KINDS,
	MAX_SOURCE_MAPPINGS,
	MAX_SYNC_RECORDS,
	parseSourcePath,
	requestPlaceholders,
	SOURCE_AUTH_KINDS,
	SOURCE_KEY_RE,
	SOURCE_LIMIT_BOUNDS,
	SOURCE_METHODS,
	SOURCE_MODES,
	SOURCE_TRIGGER_KINDS,
	type SourceSpec,
	SYNC_TRIGGER_KINDS,
	secretLeakErrors,
	sourceUrlErrors,
} from './sources.ts'
import {
	ACCENT_RE,
	BLOCK_VARIANTS,
	FIELD_TYPES,
	type FieldSpec,
	type SpecSystem,
	THEME_DENSITIES,
	THEME_FONTS,
	THEME_PRESETS,
	THEME_RADII,
	THEME_TYPE_SCALES,
} from './spec-system.ts'
import {
	ACTION_ARITIES,
	ACTION_KEY_RE,
	type ActionSpec,
	type ActionValue,
	MAX_ACTION_KEY_LENGTH,
	MAX_ACTION_SELECTION,
	MAX_ACTION_SET_FIELDS,
} from './view.ts'
import { USER_ENTITY_ID } from './virtual-entities.ts'

/**
 * A schedule's recurrence. Unknown keys are an error rather than
 * silently ignored, for the `theme.set` reason: a declaration that says
 * `everyMinute: 5` and fires monthly is worse than one that fails to load.
 */
export function recurrenceErrors(ctx: string, recurrence: unknown): string[] {
	const errors: string[] = []
	if (!recurrence || typeof recurrence !== 'object') {
		return [`${ctx}: recurrence is missing`]
	}
	const r = recurrence as Record<string, unknown>
	const kind = r.kind
	if (
		typeof kind !== 'string' ||
		!SCHEDULE_RECURRENCE_KINDS.includes(kind as never)
	) {
		return [
			`${ctx}: recurrence kind "${String(kind)}" is not one of ${SCHEDULE_RECURRENCE_KINDS.join(', ')}`,
		]
	}
	const allowed: Record<string, readonly string[]> = {
		interval: ['kind', 'everyMinutes'],
		daily: ['kind', 'atTime'],
		weekly: ['kind', 'atTime', 'onWeekday'],
		monthly: ['kind', 'atTime', 'onDayOfMonth'],
	}
	for (const key of Object.keys(r))
		if (!allowed[kind]?.includes(key))
			errors.push(
				`${ctx}: recurrence key "${key}" is not valid for kind "${kind}"`,
			)

	if (kind === 'interval') {
		const every = r.everyMinutes
		if (
			typeof every !== 'number' ||
			!Number.isInteger(every) ||
			every < MIN_INTERVAL_MINUTES ||
			every > MAX_INTERVAL_MINUTES
		)
			errors.push(
				`${ctx}: everyMinutes must be an integer in ${MIN_INTERVAL_MINUTES}–${MAX_INTERVAL_MINUTES} (past a week, use a calendar kind — an interval drifts against the calendar and "monthly" does not)`,
			)
		return errors
	}

	if (typeof r.atTime !== 'string' || !SCHEDULE_TIME_RE.test(r.atTime))
		errors.push(`${ctx}: atTime "${String(r.atTime)}" must be HH:MM (24-hour)`)
	if (kind === 'weekly') {
		const day = r.onWeekday
		if (typeof day !== 'number' || !Number.isInteger(day) || day < 0 || day > 6)
			errors.push(`${ctx}: onWeekday must be an integer 0–6 (0 = Sunday)`)
	}
	if (kind === 'monthly') {
		const day = r.onDayOfMonth
		if (
			typeof day !== 'number' ||
			!Number.isInteger(day) ||
			day < 1 ||
			day > 31
		)
			errors.push(`${ctx}: onDayOfMonth must be an integer 1–31`)
	}
	return errors
}

/**
 * A schedule's `runAs`. Absent is an error, not a default: the
 * whole point of the field is that scheduled work cannot acquire authority
 * nobody wrote down.
 */
export function runAsErrors(ctx: string, runAs: unknown): string[] {
	if (!runAs || typeof runAs !== 'object')
		return [
			`${ctx}: runAs is required — a scheduled run carries someone's authority, and an undeclared identity is implicit admin`,
		]
	const r = runAs as Record<string, unknown>
	if (
		typeof r.kind !== 'string' ||
		!SCHEDULE_RUN_AS_KINDS.includes(r.kind as never)
	)
		return [
			`${ctx}: runAs kind "${String(r.kind)}" is not one of ${SCHEDULE_RUN_AS_KINDS.join(', ')}`,
		]
	if (r.kind === 'service' && !(typeof r.role === 'string' && r.role.trim()))
		return [`${ctx}: runAs kind "service" needs a non-empty role`]
	if (r.kind === 'user' && !(typeof r.userId === 'string' && r.userId.trim()))
		return [`${ctx}: runAs kind "user" needs a non-empty userId`]
	// The org a run acts in. Optional — most scheduled work is not
	// tenant-scoped — but an empty string is not "no org", it is an org id
	// somebody meant to fill in, and honoring it would produce a run that reaches
	// no tenant-scoped row for a reason nothing states.
	if (r.orgId !== undefined && !(typeof r.orgId === 'string' && r.orgId.trim()))
		return [
			`${ctx}: runAs orgId must be a non-empty organization id when present — omit it entirely for work that is not tenant-scoped`,
		]
	// The fan-out. `eachOrg` and `orgId` are two answers to the same
	// question, and a declaration carrying both does not say which one it means —
	// so it is refused here rather than resolved by a precedence rule nobody reads.
	if (r.eachOrg !== undefined && typeof r.eachOrg !== 'boolean')
		return [`${ctx}: runAs eachOrg must be true or false when present`]
	if (r.eachOrg === true && typeof r.orgId === 'string')
		return [
			`${ctx}: runAs declares both orgId and eachOrg — a run acts in one declared org or in every org, and both together does not say which. Drop orgId to fan out, or drop eachOrg to run in that one org`,
		]
	if (r.maxOrgs !== undefined) {
		if (r.eachOrg !== true)
			return [
				`${ctx}: runAs maxOrgs bounds the eachOrg fan-out and there is none — set eachOrg: true, or drop maxOrgs`,
			]
		if (
			typeof r.maxOrgs !== 'number' ||
			!Number.isInteger(r.maxOrgs) ||
			r.maxOrgs < 1 ||
			r.maxOrgs > MAX_FANOUT_ORGS
		)
			return [
				`${ctx}: runAs maxOrgs must be an integer 1–${MAX_FANOUT_ORGS} — a fan-out spends a request per tenant against somebody else's rate limit on every fire, and past that bound the work wants its own pacing rather than a bigger number`,
			]
	}
	return []
}

/**
 * Everything wrong with one declared external source.
 *
 * Shared by `validateOp` and by {@link collectSpecSystemErrors} rather than
 * written twice, for the reason the schedule layer gives: a spec can also
 * arrive by decoding a directory somebody hand-edited, and the shapes that must
 * never be *loadable* are exactly the ones that must never be *applied* — an
 * inlined credential, an endpoint pointed at the metadata service, a mapping
 * onto a column that does not exist.
 *
 * It resolves references against `system`, so it is one function rather than a
 * pure half and a referential half kept in step.
 */
export function sourceErrors(
	ctx: string,
	source: SourceSpec,
	system: Pick<SpecSystem, 'data' | 'schedules'>,
): string[] {
	const errors: string[] = []

	if (typeof source.key !== 'string' || !SOURCE_KEY_RE.test(source.key))
		errors.push(
			`${ctx}: key "${String(source.key)}" must match ${SOURCE_KEY_RE.source}`,
		)
	if (!source.description?.trim())
		errors.push(
			`${ctx}: needs a description — an integration nobody can explain is one nobody can turn off`,
		)
	if (!(SOURCE_MODES as readonly string[]).includes(source.mode)) {
		errors.push(
			`${ctx}: mode "${String(source.mode)}" is not one of ${SOURCE_MODES.join(', ')}`,
		)
		return errors
	}

	// ---- the two gates, first: a secret in the spec and an endpoint we must
	// not reach are refusals, not warnings.
	errors.push(...secretLeakErrors(ctx, source))
	errors.push(...sourceUrlErrors(`${ctx}: request`, source.request?.url))

	const method = source.request?.method ?? 'GET'
	if (!(SOURCE_METHODS as readonly string[]).includes(method))
		errors.push(
			`${ctx}: method "${String(method)}" is not one of ${SOURCE_METHODS.join(', ')} — a source reads a third party`,
		)

	if (
		!source.auth ||
		!(SOURCE_AUTH_KINDS as readonly string[]).includes(source.auth.kind)
	)
		errors.push(
			`${ctx}: auth is required — say {kind: "none"} to state that the endpoint is public, so "unauthenticated" is a decision in the diff rather than a missing key`,
		)

	// ---- the entity and the mapping ------------------------------------------
	const entity = system.data.entities.find((e) => e.id === source.entityId)
	if (!entity) {
		errors.push(
			`${ctx}: unknown entity "${String(source.entityId)}" — add it with data.addEntity first`,
		)
	}
	const fieldById = new Map((entity?.fields ?? []).map((f) => [f.id, f]))
	const fieldNames = new Set((entity?.fields ?? []).map((f) => f.name))

	const mapping = source.mapping ?? []
	if (mapping.length === 0)
		errors.push(
			`${ctx}: needs at least one mapping — a source that maps nothing fetches for no reason`,
		)
	if (mapping.length > MAX_SOURCE_MAPPINGS)
		errors.push(
			`${ctx}: ${mapping.length} mappings exceeds the ${MAX_SOURCE_MAPPINGS} bound — past this the declaration is an ETL job, not a field mapping`,
		)
	const targets = new Set<string>()
	for (const entry of mapping) {
		if (!parseSourcePath(entry?.from))
			errors.push(
				`${ctx}: mapping from "${String(entry?.from)}" is not a response path (dotted keys and [n] indices only — no wildcards, no expressions)`,
			)
		if (entity && !fieldById.has(entry?.to))
			errors.push(
				`${ctx}: mapping to unknown field "${String(entry?.to)}" on "${source.entityId}"`,
			)
		if (targets.has(entry?.to))
			errors.push(
				`${ctx}: two mappings write field "${entry.to}" — the later one would silently win`,
			)
		targets.add(entry?.to)
	}

	// ---- limits: required, and bounded ---------------------------------------
	const limits = source.limits
	if (!limits || typeof limits !== 'object') {
		errors.push(
			`${ctx}: limits are required (requestsPerMinute, timeoutMs, maxAttempts, backoffMs) — an undeclared retry budget against a third party is a denial of service somebody else notices first`,
		)
	} else {
		const bound = (
			key: keyof typeof limits,
			min: number,
			max: number,
			why: string,
		) => {
			const value = limits[key]
			if (!Number.isInteger(value) || value < min || value > max)
				errors.push(
					`${ctx}: limits.${key} must be an integer ${min}–${max} (${why})`,
				)
		}
		bound(
			'requestsPerMinute',
			SOURCE_LIMIT_BOUNDS.minRequestsPerMinute,
			SOURCE_LIMIT_BOUNDS.maxRequestsPerMinute,
			'how hard this app may lean on somebody else’s server',
		)
		bound(
			'timeoutMs',
			SOURCE_LIMIT_BOUNDS.minTimeoutMs,
			SOURCE_LIMIT_BOUNDS.maxTimeoutMs,
			'a hung socket is not a retry',
		)
		bound(
			'maxAttempts',
			SOURCE_LIMIT_BOUNDS.minAttempts,
			SOURCE_LIMIT_BOUNDS.maxAttempts,
			'1 means no retry',
		)
		bound(
			'backoffMs',
			SOURCE_LIMIT_BOUNDS.minBackoffMs,
			SOURCE_LIMIT_BOUNDS.maxBackoffMs,
			'the first backoff; it doubles per attempt',
		)
	}

	// ---- triggers, and their agreement with the mode -------------------------
	const triggers = source.triggers ?? []
	if (triggers.length === 0)
		errors.push(
			`${ctx}: needs at least one trigger — a source nothing runs is a declaration that never fetches`,
		)
	const legal =
		source.mode === 'enrich' ? ENRICH_TRIGGER_KINDS : SYNC_TRIGGER_KINDS
	const scheduleKeys = new Set(
		(system.schedules?.schedules ?? []).map((s) => s.key),
	)
	for (const trigger of triggers) {
		if (!(SOURCE_TRIGGER_KINDS as readonly string[]).includes(trigger?.kind)) {
			errors.push(
				`${ctx}: trigger "${String(trigger?.kind)}" is not one of ${SOURCE_TRIGGER_KINDS.join(', ')}`,
			)
			continue
		}
		if (!legal.includes(trigger.kind))
			errors.push(
				`${ctx}: trigger "${trigger.kind}" is not legal in ${source.mode} mode (allowed: ${legal.join(', ')})`,
			)
		if (trigger.kind === 'schedule' && !scheduleKeys.has(trigger.scheduleKey))
			errors.push(
				`${ctx}: trigger names undeclared schedule "${trigger.scheduleKey}" — declare it with schedules.declare first`,
			)
	}

	// ---- mode-specific shape --------------------------------------------------
	if (source.mode === 'enrich') {
		if (source.collection !== undefined)
			errors.push(
				`${ctx}: collection is for sync mode — an enrichment reads one document about one row`,
			)
		if (!source.inputField)
			errors.push(
				`${ctx}: enrich mode needs an inputField — the value that drives the lookup, and the one whose absence means "nothing to ask about" rather than "fire a request anyway"`,
			)
		else if (entity && !fieldById.has(source.inputField))
			errors.push(
				`${ctx}: inputField "${source.inputField}" is not a field on "${source.entityId}"`,
			)
	} else {
		if (source.inputField !== undefined)
			errors.push(
				`${ctx}: inputField is for enrich mode — a sync has no triggering row to read it from`,
			)
		const collection = source.collection
		if (!collection) {
			errors.push(
				`${ctx}: sync mode needs a collection (idPath, idField, maxRecords) — without a stable remote id every run appends the same rows again`,
			)
		} else {
			if (collection.path !== undefined && !parseSourcePath(collection.path))
				errors.push(
					`${ctx}: collection.path "${String(collection.path)}" is not a response path`,
				)
			if (!parseSourcePath(collection.idPath))
				errors.push(
					`${ctx}: collection.idPath "${String(collection.idPath)}" is not a response path`,
				)
			if (entity && !fieldById.has(collection.idField))
				errors.push(
					`${ctx}: collection.idField "${String(collection.idField)}" is not a field on "${source.entityId}"`,
				)
			else if (entity) {
				const type = fieldById.get(collection.idField)?.type
				if (type !== 'string')
					errors.push(
						`${ctx}: collection.idField "${collection.idField}" is a ${type} column — a remote id is an opaque string, and coercing one to a number loses leading zeroes and overflows`,
					)
			}
			if (
				!Number.isInteger(collection.maxRecords) ||
				collection.maxRecords < 1 ||
				collection.maxRecords > MAX_SYNC_RECORDS
			)
				errors.push(
					`${ctx}: collection.maxRecords must be an integer 1–${MAX_SYNC_RECORDS} — an unbounded pull is how a sync that worked in staging fills a production disk`,
				)
		}
	}

	// ---- placeholders ---------------------------------------------------------
	const placeholders = requestPlaceholders(source.request ?? { url: '' })
	if (placeholders.length > 0 && source.mode !== 'enrich')
		errors.push(
			`${ctx}: request uses placeholders (${placeholders.join(', ')}) but a sync has no triggering row to resolve them from`,
		)
	if (entity && source.mode === 'enrich')
		for (const name of placeholders)
			if (!fieldNames.has(name))
				errors.push(
					`${ctx}: placeholder "{${name}}" is not a field name on "${source.entityId}"`,
				)

	return errors
}

/**
 * Everything wrong with one declared search index.
 *
 * Shared by `validateOp` and by {@link collectSpecSystemErrors} for the same
 * reason `sourceErrors` is: a spec can arrive by decoding a directory somebody
 * hand-edited, and the shapes that must never be *applied* are exactly the ones
 * that must never be *loadable*. Here that matters more than usual, because the
 * things this function refuses are the ones that would otherwise reach SQL: a
 * language outside the enum, a weight outside `A`–`D`, a field that is not a
 * column of the entity being indexed. The emitted DDL interpolates those values
 * as literals, so this check is the boundary that makes that safe — everything
 * downstream may assume it passed.
 *
 * `siblings` is every *other* declared index, so the one-index-per-entity rule
 * is enforced here rather than only in the op, which is what makes a hand-edited
 * `search.json` with two indexes on one table fail to load instead of quietly
 * producing two GIN indexes nobody asked for.
 */
export function searchIndexErrors(
	ctx: string,
	index: SearchIndexSpec,
	system: Pick<SpecSystem, 'data'>,
	siblings: readonly SearchIndexSpec[] = [],
): string[] {
	const errors: string[] = []

	if (typeof index.key !== 'string' || !SEARCH_KEY_RE.test(index.key))
		errors.push(
			`${ctx}: key "${String(index.key)}" must match ${SEARCH_KEY_RE.source}`,
		)
	else if (index.key.length > MAX_SEARCH_KEY_LENGTH)
		errors.push(
			`${ctx}: key "${index.key}" is ${index.key.length} characters — the maximum is ${MAX_SEARCH_KEY_LENGTH}, because the key becomes a database identifier and Postgres truncates those past 63 bytes without telling you`,
		)
	if (!index.description?.trim())
		errors.push(
			`${ctx}: needs a description — an index nobody can explain is one nobody can decide to stop paying for`,
		)
	if (!(SEARCH_LANGUAGES as readonly string[]).includes(index.language))
		errors.push(
			`${ctx}: language "${String(index.language)}" is not one of the configurations core Postgres ships (${SEARCH_LANGUAGES.length} of them; use "simple" for text that is not prose)`,
		)
	if (typeof index.indexed !== 'boolean')
		errors.push(
			`${ctx}: indexed must be true or false — whether this costs every write is a decision, not a default`,
		)

	const entity = system.data.entities.find((e) => e.id === index.entityId)
	if (!entity) {
		errors.push(`${ctx}: unknown entity "${String(index.entityId)}"`)
		return errors
	}

	// One index per entity. Checked against the other declarations rather than
	// only inside the declare op, so a hand-edited file cannot hold two.
	if (siblings.some((s) => s.id !== index.id && s.entityId === index.entityId))
		errors.push(
			`${ctx}: entity "${index.entityId}" already has a search index — one entity has one answer to "what does searching this mean", and the weights are how you express the rest`,
		)

	const fields = index.fields ?? []
	if (fields.length === 0)
		errors.push(
			`${ctx}: needs at least one field — an index over nothing ranks nothing`,
		)
	if (fields.length > MAX_SEARCH_FIELDS)
		errors.push(
			`${ctx}: ${fields.length} fields exceeds the maximum of ${MAX_SEARCH_FIELDS}`,
		)

	const seen = new Set<string>()
	for (const field of fields) {
		if (seen.has(field.fieldId))
			errors.push(
				`${ctx}: field "${field.fieldId}" is listed twice — a field has one weight`,
			)
		seen.add(field.fieldId)
		if (!(SEARCH_WEIGHTS as readonly string[]).includes(field.weight))
			errors.push(
				`${ctx}: field "${field.fieldId}" weight "${String(field.weight)}" is not one of ${SEARCH_WEIGHTS.join(', ')}`,
			)
		const spec = entity.fields.find((f) => f.id === field.fieldId)
		if (!spec) {
			errors.push(
				`${ctx}: field "${field.fieldId}" is not a field of entity "${index.entityId}"`,
			)
			continue
		}
		// A reference column holds the referenced row's id, so indexing it makes
		// searching match raw uuids — which surfaces ids to anyone with a search
		// box and never matches anything a person would type.
		if (spec.reference)
			errors.push(
				`${ctx}: field "${spec.name}" is a reference — it stores an id, not text; index the referenced entity instead`,
			)
		else if (spec.rank)
			errors.push(
				`${ctx}: field "${spec.name}" is a rank key — it holds an ordering position, not text`,
			)
		else if (!searchableFieldTypes.includes(spec.type))
			errors.push(
				`${ctx}: field "${spec.name}" is a ${spec.type} — only ${searchableFieldTypes.join(' and ')} fields carry language; filter on it instead, which is already indexed and exact`,
			)
	}

	return errors
}

/**
 * The names a document's `{placeholder}` may resolve to on one entity: its
 * stored fields plus its derived values. Derived values are included for the
 * reason `DocumentFieldsSection` gives — an invoice total is a rollup, and a
 * template that could print the line items but not their sum would push every
 * real document straight back off the surface.
 */
function printableNames(
	entity: SpecSystem['data']['entities'][number],
): Map<string, { id: string; type: string; kind: 'field' | 'derived' }> {
	const out = new Map<
		string,
		{ id: string; type: string; kind: 'field' | 'derived' }
	>()
	for (const f of entity.fields)
		out.set(f.name, { id: f.id, type: f.type, kind: 'field' })
	// A computed value is arithmetic over number fields and a rollup is an
	// aggregate, so both print as numbers. Typed here rather than inferred at
	// render time so the formatter and the validator agree by construction.
	for (const c of entity.computed ?? [])
		out.set(c.name, { id: c.id, type: 'number', kind: 'derived' })
	for (const r of entity.rollups ?? [])
		out.set(r.name, { id: r.id, type: 'number', kind: 'derived' })
	return out
}

/** The same map keyed by id — what a section's `fieldIds` are resolved through. */
function printableById(
	entity: SpecSystem['data']['entities'][number],
): Map<string, { name: string; type: string; kind: 'field' | 'derived' }> {
	const out = new Map<
		string,
		{ name: string; type: string; kind: 'field' | 'derived' }
	>()
	for (const [name, meta] of printableNames(entity))
		out.set(meta.id, { name, type: meta.type, kind: meta.kind })
	return out
}

/** Every `{placeholder}` in a template string that is not a printable name on the entity. */
function placeholderErrors(
	ctx: string,
	what: string,
	text: string,
	entity: SpecSystem['data']['entities'][number],
): string[] {
	const names = printableNames(entity)
	return documentPlaceholders(text)
		.filter((name) => !names.has(name))
		.map(
			(name) =>
				`${ctx}: ${what} placeholder "{${name}}" is not a field or derived value on "${entity.id}"`,
		)
}

/**
 * Everything wrong with one declared importer.
 *
 * Shared by `validateOp` and by {@link collectSpecSystemErrors} for the reason
 * the three validators above are: a spec can arrive by decoding a directory
 * somebody hand-edited, and the shapes that must never be *applied* are exactly
 * the ones that must never be *loadable*.
 *
 * What it is guarding is the most destructive surface in the L2 vocabulary. Two
 * of these refusals are the issue's gating bullets made mechanical:
 *
 *  - **A boolean (or date, or json) upsert key is refused outright**, not warned
 *    about. A boolean key partitions the table into two buckets and the first run
 *    overwrites every row with the last matching line of the file. That is "just
 *    overwrite everything" reachable by picking the wrong entry from a dropdown,
 *    so the vocabulary refuses to be able to say it.
 *  - **A `file` column is refused**, on `sources`' argument: only the upload path
 *    mints a storage key, so a key in a CSV is one nobody minted.
 *
 * The rest are the quieter kind — a duplicate `fieldId` is two file columns
 * writing one field, where the winner is whichever the runtime applied last, and
 * an upsert key absent from `columns` is a match on a value the file never
 * supplies (which silently degrades to insert-only, i.e. duplicates).
 *
 * `siblings` is every *other* declared importer, so key uniqueness is enforced
 * here rather than only in the op: two importers sharing a key share a URL, an
 * audit label and a parser module path.
 */
export function importerErrors(
	ctx: string,
	importer: ImporterSpec,
	system: Pick<SpecSystem, 'data'>,
	siblings: readonly ImporterSpec[] = [],
): string[] {
	const errors: string[] = []

	if (typeof importer.key !== 'string' || !IMPORT_KEY_RE.test(importer.key))
		errors.push(
			`${ctx}: key "${String(importer.key)}" must match ${IMPORT_KEY_RE.source}`,
		)
	else if (importer.key.length > MAX_IMPORT_KEY_LENGTH)
		errors.push(
			`${ctx}: key "${importer.key}" is ${importer.key.length} characters — the maximum is ${MAX_IMPORT_KEY_LENGTH}; it is a URL segment, a module name and an audit label`,
		)
	if (siblings.some((s) => s.id !== importer.id && s.key === importer.key))
		errors.push(
			`${ctx}: importer key "${String(importer.key)}" is already declared — a key is a URL segment, an audit label and a parser module path, and two importers cannot share one`,
		)
	if (!importer.description?.trim())
		errors.push(
			`${ctx}: needs a description — an importer nobody can explain is one nobody can decide to pause`,
		)
	if (!(IMPORT_FORMATS as readonly string[]).includes(importer.format))
		errors.push(
			`${ctx}: format "${String(importer.format)}" is not one of ${IMPORT_FORMATS.join(', ')}`,
		)
	// The parser slot exists iff the platform does not know how to read the file.
	// Allowing one on a csv importer would be a second, silent way to reinterpret
	// a format that already has a reader, and the two would disagree the first
	// time somebody changed one.
	if (importer.format === 'custom') {
		if (
			typeof importer.parserSlot !== 'string' ||
			!IMPORT_PARSER_SLOT_RE.test(importer.parserSlot)
		)
			errors.push(
				`${ctx}: format "custom" requires a parserSlot matching ${IMPORT_PARSER_SLOT_RE.source} — the platform does not know how to read this file, and naming the module that does is what keeps that honest`,
			)
	} else if (importer.parserSlot !== undefined)
		errors.push(
			`${ctx}: parserSlot is only legal on format "custom" — a "${String(importer.format)}" file already has a reader, and a second one would be a silent second interpretation of the same bytes`,
		)
	if (typeof importer.paused !== 'boolean')
		errors.push(
			`${ctx}: paused must be true or false — whether this write path is open is a decision, not a default`,
		)
	if (
		typeof importer.maxRows !== 'number' ||
		!Number.isInteger(importer.maxRows) ||
		importer.maxRows < 1 ||
		importer.maxRows > MAX_IMPORT_ROWS
	)
		errors.push(
			`${ctx}: maxRows must be an integer 1–${MAX_IMPORT_ROWS} — a run that exceeds it FAILS rather than truncating, because a silently truncated import looks exactly like a successful one`,
		)

	const entity = system.data.entities.find((e) => e.id === importer.entityId)
	if (!entity) {
		errors.push(`${ctx}: unknown entity "${String(importer.entityId)}"`)
		return errors
	}

	const columns = importer.columns ?? []
	if (columns.length === 0)
		errors.push(
			`${ctx}: needs at least one column mapping — an importer that maps nothing writes empty rows`,
		)
	if (columns.length > MAX_IMPORT_COLUMNS)
		errors.push(
			`${ctx}: ${columns.length} column mappings exceeds the maximum of ${MAX_IMPORT_COLUMNS}`,
		)

	const seenColumns = new Set<string>()
	const seenFields = new Set<string>()
	const mappedFieldIds = new Set<string>()
	for (const column of columns) {
		if (typeof column?.column !== 'string' || column.column.trim() === '') {
			errors.push(`${ctx}: every column mapping needs a non-empty column name`)
			continue
		}
		if (seenColumns.has(column.column))
			errors.push(
				`${ctx}: column "${column.column}" is mapped twice — one file column has one destination; splitting a value is what the parser slot is for`,
			)
		seenColumns.add(column.column)
		if (seenFields.has(column.fieldId))
			errors.push(
				`${ctx}: field "${column.fieldId}" is the destination of two columns — the winner would be whichever the runtime applied last, which is data loss that depends on declaration order`,
			)
		seenFields.add(column.fieldId)
		// Checked against its OWNER entity, not merely against existence: a field
		// id from another entity resolves, and would map this file's column onto
		// somebody else's table.
		const spec = entity.fields.find((f) => f.id === column.fieldId)
		if (!spec) {
			errors.push(
				`${ctx}: field "${String(column.fieldId)}" is not a field of entity "${importer.entityId}"`,
			)
			continue
		}
		mappedFieldIds.add(column.fieldId)
		if (spec.rank)
			errors.push(
				`${ctx}: field "${spec.name}" is a rank key — it holds a server-generated ordering position, and a value from a file would place rows against an order the file cannot see`,
			)
		else if (!importableFieldTypes.includes(spec.type))
			errors.push(
				`${ctx}: field "${spec.name}" is a ${spec.type} — a file column holds text, and a file field stores a storage key that only the upload path can mint, so a value here would be a key nobody minted`,
			)
	}

	// `undefined` is not `null`. The key is REQUIRED and nullable, so omitting it
	// is an author who has not decided yet, which is exactly the state that must
	// not reach a spec — see `ImporterSpec.upsertFieldId`.
	if (importer.upsertFieldId === undefined)
		errors.push(
			`${ctx}: upsertFieldId is required — pass null for insert-only, or name the field that decides whether a row already exists. It is the single lever that decides whether running this can overwrite rows somebody already has, so it is never defaulted`,
		)
	else if (importer.upsertFieldId !== null) {
		const key = entity.fields.find((f) => f.id === importer.upsertFieldId)
		if (!key)
			errors.push(
				`${ctx}: upsert key "${String(importer.upsertFieldId)}" is not a field of entity "${importer.entityId}"`,
			)
		else {
			if (!upsertKeyFieldTypes.includes(key.type))
				errors.push(
					`${ctx}: upsert key "${key.name}" is a ${key.type} — only ${upsertKeyFieldTypes.join(', ')} fields identify a row. A boolean key collapses the whole table onto two rows on the first run, a date matches either nothing or everything sharing a day, and equality on json is equality on its serialization`,
				)
			if (key.reference)
				errors.push(
					`${ctx}: upsert key "${key.name}" is a reference — it holds the parent's id, so matching on it would overwrite every row sharing a parent with the last line of the file that names it`,
				)
			if (!mappedFieldIds.has(importer.upsertFieldId))
				errors.push(
					`${ctx}: upsert key "${key.name}" is not among the mapped columns — you cannot match on a value the file does not supply, and an unmatched key silently degrades to insert-only, i.e. duplicates`,
				)
		}
	}

	return errors
}

/**
 * Everything wrong with one declared live subscription.
 *
 * Shared by `validateOp` and by {@link collectSpecSystemErrors} for the reason
 * every validator above is shared: a spec can arrive by decoding a directory
 * somebody hand-edited, and the shapes that must never be *applied* are exactly
 * the ones that must never be *loadable*.
 *
 * What this one is guarding is different from the portal validator's job and
 * worth naming. A portal decides who can *see* something; a subscription decides
 * what the app *does to itself* while people are watching. So the refusals split
 * in two, and each one has a test named after what it prevents rather than after
 * the rule:
 *
 *  - **Exposure.** A field id from another entity resolves and would push
 *    somebody else's column, so fields are checked against their owner entity.
 *    A `file` field is refused outright: a storage key on a push is a storage key
 *    on the wire, sent to everybody holding the channel open, on every write.
 *  - **Load.** Both ceilings are required and bounded, and an unfiltered channel
 *    is capped far lower than a filtered one, because an unfiltered channel's
 *    cost is `writes × subscribers` with no term that shrinks.
 *  - **Scope discipline.** A `presence` channel is row-scoped and carries no
 *    fields at all. Both refusals exist to keep the primitive from growing into
 *    the co-editing layer issue #179 explicitly puts out of scope: a presence
 *    entry with a payload is a cursor protocol with the name filed off, and a
 *    presence channel wider than one row is a live directory of everyone in the
 *    app.
 *
 * `siblings` is every *other* declared subscription, so both key uniqueness and
 * the one-per-(entity, kind) cardinality rule are enforced here rather than only
 * in the op — a hand-edited `live.json` with two query channels on one table
 * would double the write-path cost of every insert with nothing to say which
 * channel a surface should use.
 */
export function liveSubscriptionErrors(
	ctx: string,
	sub: LiveSubscriptionSpec,
	system: Pick<SpecSystem, 'data'>,
	siblings: readonly LiveSubscriptionSpec[] = [],
): string[] {
	const errors: string[] = []

	if (typeof sub.key !== 'string' || !LIVE_KEY_RE.test(sub.key))
		errors.push(
			`${ctx}: key "${String(sub.key)}" must match ${LIVE_KEY_RE.source}`,
		)
	else if (sub.key.length > MAX_LIVE_KEY_LENGTH)
		errors.push(
			`${ctx}: key "${sub.key}" is ${sub.key.length} characters — the maximum is ${MAX_LIVE_KEY_LENGTH}; it is a URL segment, a metric label and a generated module name`,
		)
	if (siblings.some((s) => s.id !== sub.id && s.key === sub.key))
		errors.push(
			`${ctx}: live key "${String(sub.key)}" is already declared — a key is a URL segment and a metric label, and two channels cannot share one`,
		)
	if (!sub.description?.trim())
		errors.push(
			`${ctx}: needs a description — it is what the load report prints beside the ceilings, and a channel nobody can explain is one nobody can decide to pause at 3am`,
		)
	if (typeof sub.paused !== 'boolean')
		errors.push(
			`${ctx}: paused must be true or false — whether this channel accepts connections is a decision, not a default. It is safe to flip precisely because subscribers fall back to polling`,
		)
	if (typeof sub.slot !== 'boolean')
		errors.push(
			`${ctx}: slot must be true or false — whether the platform opens a user-owned file for this channel is a decision about the generated tree, and a default would either emit code nobody asked for or silently withhold the seam a bespoke surface needs`,
		)
	if (!(LIVE_KINDS as readonly string[]).includes(sub.kind)) {
		errors.push(
			`${ctx}: kind "${String(sub.kind)}" is not one of ${LIVE_KINDS.join(', ')}. There is deliberately no "event" or "custom" kind: every message exists because a ROW CHANGED, which is what makes it authorizable as a read of that row. A caller-composed payload has no row to check and would need an access model of its own`,
		)
		return errors
	}

	// ---- the two ceilings ----------------------------------------------------
	// Required and bounded before anything else touches the entity, because these
	// are the numbers that decide whether this declaration is a live board or an
	// outage, and they are the ones an author is most likely to leave out.
	if (
		typeof sub.maxSubscribers !== 'number' ||
		!Number.isInteger(sub.maxSubscribers) ||
		sub.maxSubscribers < 1 ||
		sub.maxSubscribers > MAX_LIVE_SUBSCRIBERS
	)
		errors.push(
			`${ctx}: maxSubscribers must be an integer 1–${MAX_LIVE_SUBSCRIBERS}. Required and never defaulted — how many connections this channel may hold open is a decision about somebody's deployment, and a default is that decision made by whoever wrote the generator`,
		)
	if (
		typeof sub.maxMessagesPerMinute !== 'number' ||
		!Number.isInteger(sub.maxMessagesPerMinute) ||
		sub.maxMessagesPerMinute < 1 ||
		sub.maxMessagesPerMinute > MAX_LIVE_MESSAGE_RATE
	)
		errors.push(
			`${ctx}: maxMessagesPerMinute must be an integer 1–${MAX_LIVE_MESSAGE_RATE}. Required and never defaulted: a subscriber over it is SHED with a reason rather than buffered, because an unbounded buffer is how one slow client takes the process down`,
		)

	// ---- the bound -----------------------------------------------------------
	const scope = sub.scope
	if (!scope || !(LIVE_SCOPE_KINDS as readonly string[]).includes(scope.kind))
		errors.push(
			`${ctx}: scope must be {kind:"row"}, {kind:"filtered", fieldId}, or {kind:"all"}. Required and never unbounded by omission — a subscription with no bound is a broadcast of the whole table, which is the storm this layer exists to make unspellable`,
		)
	else if (
		scope.kind === 'all' &&
		sub.maxSubscribers > MAX_UNBOUNDED_SUBSCRIBERS
	)
		errors.push(
			`${ctx}: scope "all" may declare at most ${MAX_UNBOUNDED_SUBSCRIBERS} subscribers (this declares ${sub.maxSubscribers}). An unfiltered channel costs writes × subscribers with no term that shrinks, so ${MAX_UNBOUNDED_SUBSCRIBERS} is the size of a TEAM, not of a customer base: an internal ops dashboard is the honest "all" case and is bounded by headcount. Anything bounded by signups needs scope "filtered"`,
		)

	// ---- presence, and the two rules that keep it from becoming co-editing ----
	if (sub.kind === 'presence') {
		if (scope?.kind !== 'row')
			errors.push(
				`${ctx}: a presence channel requires scope {kind:"row"}. Presence is "who is viewing THIS record" — that is the bounded primitive issue #179 asks for, and anything wider is a live directory of everyone in the app, which nobody asked for and which broadcasts who is working on what`,
			)
		if ((sub.fields?.length ?? 0) > 0)
			errors.push(
				`${ctx}: a presence channel must declare no fields. Presence reports IDENTITIES and nothing else — no row data, no cursor position, no free-form payload — because a payload field is exactly where a cursor protocol grows, and the cheapest way to not ship one is to have nowhere to put it`,
			)
		if (
			typeof sub.presenceTtlSeconds !== 'number' ||
			!Number.isInteger(sub.presenceTtlSeconds) ||
			sub.presenceTtlSeconds < 1 ||
			sub.presenceTtlSeconds > MAX_PRESENCE_TTL_SECONDS
		)
			errors.push(
				`${ctx}: presenceTtlSeconds must be an integer 1–${MAX_PRESENCE_TTL_SECONDS}. Required and never defaulted: a browser tab that crashed sends no goodbye, and the only thing that ever removes its entry is a TTL somebody chose`,
			)
		if (
			typeof sub.maxPresent !== 'number' ||
			!Number.isInteger(sub.maxPresent) ||
			sub.maxPresent < 1 ||
			sub.maxPresent > MAX_PRESENT
		)
			errors.push(
				`${ctx}: maxPresent must be an integer 1–${MAX_PRESENT}. A cap rather than a page: "212 people are viewing this" is a count, and a list of 212 identities is a directory export with a live feed attached`,
			)
	} else {
		if (sub.presenceTtlSeconds !== undefined)
			errors.push(
				`${ctx}: presenceTtlSeconds is only legal on kind "presence" — a TTL on a query channel describes an expiry for rows, which is a retention policy and not this`,
			)
		if (sub.maxPresent !== undefined)
			errors.push(
				`${ctx}: maxPresent is only legal on kind "presence" — a query channel pushes rows, and the bound on how many is the scope`,
			)
	}

	const entity = system.data.entities.find((e) => e.id === sub.entityId)
	if (!entity) {
		errors.push(`${ctx}: unknown entity "${String(sub.entityId)}"`)
		return errors
	}
	// One query and one presence channel per entity. `search.declare`'s
	// cardinality argument, and the same one: every write to this table pays for
	// every declared channel over it, so two answers to "what does following this
	// table mean" are two costs on every insert with nothing to say which one a
	// surface should use. A portal may be several per entity because an audience
	// is chosen by the reader; a subscription's cost is chosen by nobody.
	if (
		siblings.some(
			(s) =>
				s.id !== sub.id && s.entityId === sub.entityId && s.kind === sub.kind,
		)
	)
		errors.push(
			`${ctx}: entity "${sub.entityId}" already declares a "${sub.kind}" channel. At most one per (entity, kind): every write to this table pays for every channel over it, and two would double that cost forever with nothing to say which one a surface should read`,
		)

	// Checked against its OWNER entity, not merely against existence: a field id
	// from another entity resolves, and would push somebody else's column.
	const fieldsById = new Map(entity.fields.map((f) => [f.id, f]))

	if (scope?.kind === 'filtered') {
		const field = fieldsById.get(scope.fieldId)
		if (!field)
			errors.push(
				`${ctx}: scope field "${String(scope.fieldId)}" is not a field of entity "${sub.entityId}"`,
			)
		else if (!liveScopeFieldTypes.includes(field.type))
			errors.push(
				`${ctx}: scope field "${field.name}" is a ${field.type} — a bound has to be an equality somebody can read, and only ${liveScopeFieldTypes.join(', ')} fields are. A date bound matches a microsecond; a json bound matches a serialization`,
			)
	}

	if (sub.kind === 'query') {
		const fields = sub.fields ?? []
		if (!Array.isArray(sub.fields) || fields.length === 0)
			errors.push(
				`${ctx}: a query channel must name at least one field. There is deliberately no "push everything" spelling and no exclusion list: an "all except" list silently pushes every column added AFTER it was written, and a push is a read`,
			)
		if (fields.length > MAX_LIVE_FIELDS)
			errors.push(
				`${ctx}: ${fields.length} pushed fields exceeds the maximum of ${MAX_LIVE_FIELDS} — past that a push stops being a notification and becomes a row dump on every write`,
			)
		const seen = new Set<string>()
		for (const fieldId of fields) {
			if (seen.has(fieldId))
				errors.push(`${ctx}: fields names "${fieldId}" twice`)
			seen.add(fieldId)
			const field = fieldsById.get(fieldId)
			if (!field) {
				errors.push(
					`${ctx}: field "${String(fieldId)}" is not a field of entity "${sub.entityId}"`,
				)
				continue
			}
			if (!pushableFieldTypes.includes(field.type))
				errors.push(
					`${ctx}: field "${field.name}" is a ${field.type} and may not be pushed. A file column holds a STORAGE KEY, which is an object path rather than a value — putting one on a push hands a URL into the bucket to everybody holding the channel open, on every write, rather than on a request somebody made`,
				)
		}
	}

	return errors
}

/**
 * Everything wrong with one declared list action.
 *
 * Shared by `validateOp` and by {@link collectSpecSystemErrors} on
 * {@link portalErrors}' argument, and here it carries the same weight: a spec
 * can arrive by decoding a directory somebody hand-edited, and an action that
 * reached the runtime that way is a button nobody reviewed with the power to
 * rewrite five hundred rows.
 *
 * **Every refusal here is a specific way a run could do more than its
 * declaration says**, and each is checked rather than documented:
 *
 *  - A field id from another entity **resolves**, and would write somebody
 *    else's column, so the write set is checked against its owner entity rather
 *    than merely for existence — `portalErrors`' first rule, in the write
 *    direction.
 *  - A `null` on a required field is refused by name here rather than by the
 *    database at run time, so the refusal arrives while somebody is reviewing
 *    the declaration instead of on the fourteenth row of a batch.
 *  - A `rank` key, a `file` field and a `json` field are unwritable: the first
 *    is a drag-ordering key nobody types (a fixed value would stack the whole
 *    selection at one position), the second holds a storage path (a fixed key
 *    would point five hundred rows at one object), and the third is a document
 *    nobody reviewing a string literal can read.
 *
 *    The **tenant** and **soft-delete** columns are deliberately not checked
 *    here, and their absence is not a hole: which column is the tenant is a
 *    registry fact only owned code sets, so no spec-layer check can see it.
 *    `opUpdate` strips both from every payload it is given, and an action's
 *    write reaches the database through exactly that path — so the protection
 *    is structural rather than declared, and it covers a hand-edited
 *    `view.json` as well as a validated op.
 *  - `choose` must name an `enum` field of this entity **with declared
 *    options**, because the options are the entire bound on what a run can
 *    produce. An enum with no option list is free text wearing a dropdown.
 *  - The declared cap is required, at least 1, and no larger than
 *    {@link MAX_ACTION_SELECTION}.
 *  - A `row`-arity action may still declare a cap above 1 — that is not an
 *    error, it is an author saying "one button now, a toolbar later" — but the
 *    endpoint enforces the declared number, not the arity.
 *
 * `siblings` is every *other* declared action, so key uniqueness is enforced
 * here rather than only in the op: two actions sharing a key share an endpoint
 * and an MCP tool name.
 */
export function actionErrors(
	ctx: string,
	action: ActionSpec,
	system: Pick<SpecSystem, 'data'>,
	siblings: readonly ActionSpec[] = [],
): string[] {
	const errors: string[] = []

	if (typeof action.key !== 'string' || !ACTION_KEY_RE.test(action.key))
		errors.push(
			`${ctx}: key "${String(action.key)}" must match ${ACTION_KEY_RE.source}`,
		)
	else if (action.key.length > MAX_ACTION_KEY_LENGTH)
		errors.push(
			`${ctx}: key "${action.key}" is ${action.key.length} characters — the maximum is ${MAX_ACTION_KEY_LENGTH}; it is a URL segment, an audit label and an MCP tool name`,
		)
	if (siblings.some((a) => a.id !== action.id && a.key === action.key))
		errors.push(
			`${ctx}: action key "${String(action.key)}" is already declared — a key is an endpoint and an MCP tool name, and two actions cannot share one`,
		)
	if (!action.label?.trim())
		errors.push(`${ctx}: needs a label — it is the text on the button`)
	if (!action.description?.trim())
		errors.push(
			`${ctx}: needs a description — it is what the action report prints beside the write, and a button that changes ${action.maxSelection ?? 'many'} rows at once and that nobody can explain is one nobody can decide to remove`,
		)
	if (!(ACTION_ARITIES as readonly string[]).includes(action.arity))
		errors.push(
			`${ctx}: arity "${String(action.arity)}" is not one of ${ACTION_ARITIES.join(', ')}`,
		)
	if (typeof action.undoable !== 'boolean')
		errors.push(
			`${ctx}: undoable must be true or false. Never defaulted — true makes every run store the prior value of every field it overwrites, which is a storage cost proportional to the selection, and false is the honest spelling of "this cannot be taken back"`,
		)
	if (
		typeof action.maxSelection !== 'number' ||
		!Number.isInteger(action.maxSelection) ||
		action.maxSelection < 1 ||
		action.maxSelection > MAX_ACTION_SELECTION
	)
		errors.push(
			`${ctx}: maxSelection must be an integer 1–${MAX_ACTION_SELECTION}. Required and never defaulted — how many rows one click may rewrite is a decision about somebody's data, and a default is that decision made by whoever wrote the generator. Past the cap a run is refused whole rather than truncated to the first N`,
		)
	if (action.role !== undefined && !action.role.trim())
		errors.push(
			`${ctx}: role must be a non-empty string when present — omit it entirely to mean "whoever may update this entity", which is a different and legitimate statement from "the empty role"`,
		)

	const entity = system.data.entities.find((e) => e.id === action.entityId)
	if (!entity) {
		errors.push(`${ctx}: unknown entity "${String(action.entityId)}"`)
		return errors
	}

	// Checked against its OWNER entity, not merely against existence: a field id
	// from another entity resolves, and would write somebody else's column.
	const fieldsById = new Map(entity.fields.map((f) => [f.id, f]))
	const set = action.effect?.set
	if (!set || typeof set !== 'object' || Array.isArray(set)) {
		errors.push(
			`${ctx}: effect.set must be an object of fieldId → literal value (it may be empty only when effect.choose is present)`,
		)
		return errors
	}
	const setKeys = Object.keys(set)
	if (setKeys.length === 0 && !action.effect.choose)
		errors.push(
			`${ctx}: an action must write something — give effect.set at least one field, or name an enum field in effect.choose. An action that writes nothing is a button that reports success and changes no row, which is worse than no button`,
		)
	if (setKeys.length > MAX_ACTION_SET_FIELDS)
		errors.push(
			`${ctx}: ${setKeys.length} written fields exceeds the maximum of ${MAX_ACTION_SET_FIELDS} — past that an action stops being a list control and becomes a migration wearing a button`,
		)

	for (const fieldId of setKeys) {
		const field = fieldsById.get(fieldId as FieldId)
		if (!field) {
			errors.push(
				`${ctx}: effect.set names "${fieldId}", which is not a field of entity "${action.entityId}"`,
			)
			continue
		}
		// `noUncheckedIndexedAccess`: a key from `Object.keys` is present, but an
		// explicit `undefined` VALUE is a caller writing `{fld-x: undefined}`,
		// which is not a literal and must not be read as "clear it".
		const value = set[fieldId]
		if (value === undefined) {
			errors.push(
				`${ctx}: effect.set gives "${field.name}" no value — write null to clear the column, which is the explicit spelling; an absent value is a caller that lost one`,
			)
			continue
		}
		if (value === null && field.required)
			errors.push(
				`${ctx}: effect.set clears required field "${field.name}" — null means "unset this column", and a required column has no unset state. Refused here rather than by the database, so the "no" arrives while somebody is reading the declaration instead of part-way through a batch`,
			)
		if (field.rank === true)
			errors.push(
				`${ctx}: field "${field.name}" is a rank key — an opaque ordering value a person sets by dragging, never by typing. Writing one from an action would place every row in the selection at the same position`,
			)
		if (field.type === 'file')
			errors.push(
				`${ctx}: field "${field.name}" is a file field, which holds a STORAGE KEY rather than a value. A fixed key would point every row in the selection at one object, and there is no upload in an action's declaration to produce a different one`,
			)
		if (field.type === 'json' && value !== null)
			errors.push(
				`${ctx}: field "${field.name}" is a json field, and effect values are literals. A JSON document written as a string literal is a value nobody reviewing this declaration can read`,
			)
		if (
			field.type === 'enum' &&
			typeof value === 'string' &&
			(field.options?.length ?? 0) > 0 &&
			!field.options?.some((o) => o.value === value)
		)
			errors.push(
				`${ctx}: effect.set gives "${field.name}" the value "${value}", which is not one of its declared options (${field.options?.map((o) => o.value).join(', ')})`,
			)
		if (value !== null && !isAssignableTo(field.type, value))
			errors.push(
				`${ctx}: effect.set gives "${field.name}" a ${typeof value}, but the field is a ${field.type}`,
			)
	}

	const choose = action.effect.choose
	if (choose !== undefined) {
		const field = fieldsById.get(choose)
		if (!field)
			errors.push(
				`${ctx}: effect.choose names "${String(choose)}", which is not a field of entity "${action.entityId}"`,
			)
		else if (field.type !== 'enum')
			errors.push(
				`${ctx}: effect.choose names "${field.name}", a ${field.type}. Only an enum field may be chosen at run time — its declared options are the entire bound on what values a run can produce, and a field without one is free text arriving through a control that looks constrained`,
			)
		else if ((field.options?.length ?? 0) === 0)
			errors.push(
				`${ctx}: effect.choose names enum field "${field.name}", which declares no options. The options ARE the bound; without them this is free text wearing a dropdown`,
			)
		else if (setKeys.includes(choose))
			errors.push(
				`${ctx}: field "${field.name}" is both written by effect.set and chosen by effect.choose — one of the two would silently win, and which one is not something a reader of this declaration should have to know`,
			)
	}

	return errors
}

/** Whether a literal from an action's write set fits the field's type. `date`
 *  is accepted as a string (an ISO instant) rather than parsed here: what a
 *  date column accepts is the update path's question, and duplicating the
 *  answer is how the two come to disagree. */
function isAssignableTo(type: FieldSpec['type'], value: ActionValue): boolean {
	switch (type) {
		case 'number':
			return typeof value === 'number'
		case 'boolean':
			return typeof value === 'boolean'
		case 'string':
		case 'enum':
		case 'date':
			return typeof value === 'string'
		default:
			return true
	}
}

/**
 * Everything wrong with one declared portal.
 *
 * Shared by `validateOp` and by {@link collectSpecSystemErrors} for the reason
 * every validator above is shared, and here the reason is at its sharpest: a
 * spec can arrive by decoding a directory somebody hand-edited, and the shapes
 * that must never be *applied* are exactly the ones that must never be
 * *loadable*. A portal that reached the runtime through a hand-edited
 * `portals.json` would be a public surface nobody reviewed.
 *
 * **Every refusal here is a specific exposure**, and each has a test named after
 * the exposure rather than after the rule:
 *
 *  - A field id from another entity **resolves** and would project somebody
 *    else's column onto this portal, so fields are checked against their owner
 *    entity rather than merely for existence.
 *  - A `public` or `token` portal may not expose a `file` field (a storage key is
 *    an object path) or a reference to `e-user` (an identity-table primary key,
 *    i.e. a way to enumerate accounts).
 *  - A `public` portal may not declare `update`: anonymous update means anyone
 *    on the internet may edit a row that already exists.
 *  - A `collection` portal must carry a filter; a `row` portal must be
 *    token-scoped, because the only thing that can name one row from outside
 *    without being guessable, revocable and expiring is a credential.
 *  - A token policy must expire, and must expire within a year.
 *
 * `siblings` is every *other* declared portal, so key uniqueness is enforced
 * here rather than only in the op: two portals sharing a key share a URL.
 */
export function portalErrors(
	ctx: string,
	portal: PortalSpec,
	system: Pick<SpecSystem, 'data'>,
	siblings: readonly PortalSpec[] = [],
): string[] {
	const errors: string[] = []

	if (typeof portal.key !== 'string' || !PORTAL_KEY_RE.test(portal.key))
		errors.push(
			`${ctx}: key "${String(portal.key)}" must match ${PORTAL_KEY_RE.source}`,
		)
	else if (portal.key.length > MAX_PORTAL_KEY_LENGTH)
		errors.push(
			`${ctx}: key "${portal.key}" is ${portal.key.length} characters — the maximum is ${MAX_PORTAL_KEY_LENGTH}; it is a URL segment, an audit label and a rate-limit bucket`,
		)
	if (siblings.some((s) => s.id !== portal.id && s.key === portal.key))
		errors.push(
			`${ctx}: portal key "${String(portal.key)}" is already declared — a key is a URL segment, and two portals cannot share one`,
		)
	if (!portal.description?.trim())
		errors.push(
			`${ctx}: needs a description — it is what the exposure report prints beside the field list, and a portal nobody can explain is one nobody can decide to pause`,
		)
	if (typeof portal.paused !== 'boolean')
		errors.push(
			`${ctx}: paused must be true or false — whether this surface answers is a decision, not a default`,
		)
	if (!(PORTAL_AUDIENCES as readonly string[]).includes(portal.audience))
		errors.push(
			`${ctx}: audience "${String(portal.audience)}" is not one of ${PORTAL_AUDIENCES.join(', ')}`,
		)
	if (!(PORTAL_SCOPES as readonly string[]).includes(portal.scope))
		errors.push(
			`${ctx}: scope "${String(portal.scope)}" is not one of ${PORTAL_SCOPES.join(', ')}`,
		)
	if (!(PORTAL_LAYOUTS as readonly string[]).includes(portal.layout))
		errors.push(
			`${ctx}: layout "${String(portal.layout)}" is not one of ${PORTAL_LAYOUTS.join(', ')}`,
		)

	// The audience carries its own credential, and exactly one of them.
	if (portal.audience === 'role') {
		if (typeof portal.role !== 'string' || portal.role.trim() === '')
			errors.push(
				`${ctx}: audience "role" requires a role name — the whole content of the declaration is which role, and an unnamed one grants to every session`,
			)
	} else if (portal.role !== undefined)
		errors.push(
			`${ctx}: role is only legal on audience "role" — a role on a public portal reads as a restriction and enforces nothing`,
		)

	if (portal.audience === 'token') {
		const token = portal.token
		if (!token || typeof token !== 'object')
			errors.push(
				`${ctx}: audience "token" requires a token policy {ttlHours, maxUses} — there is no non-expiring portal token`,
			)
		else {
			if (
				typeof token.ttlHours !== 'number' ||
				!Number.isInteger(token.ttlHours) ||
				token.ttlHours < 1 ||
				token.ttlHours > MAX_PORTAL_TOKEN_TTL_HOURS
			)
				errors.push(
					`${ctx}: token.ttlHours must be an integer 1–${MAX_PORTAL_TOKEN_TTL_HOURS} (one year). Required and never defaulted: a link somebody emailed a client is a credential sitting in a mail archive, and the only thing that reliably closes it is an expiry chosen when it was minted`,
				)
			// `undefined` is not `null`. Unlimited-within-the-TTL is a decision;
			// omitting the key is an author who has not made one.
			if (token.maxUses === undefined)
				errors.push(
					`${ctx}: token.maxUses is required — pass null for "any number of opens before it expires", or an integer cap. Not deciding is the one thing it may not be`,
				)
			else if (
				token.maxUses !== null &&
				(!Number.isInteger(token.maxUses) || token.maxUses < 1)
			)
				errors.push(`${ctx}: token.maxUses must be null or an integer ≥ 1`)
		}
	} else if (portal.token !== undefined)
		errors.push(
			`${ctx}: token is only legal on audience "token" — a token policy on a public portal describes a credential nothing checks`,
		)

	// Scope, and the two rules that make a portal bounded by construction.
	if (portal.scope === 'row') {
		if (portal.audience !== 'token')
			errors.push(
				`${ctx}: scope "row" requires audience "token". A row portal names ONE row, and the only thing that can name it from outside without being guessable, revocable and expiring is a credential. A row id in a public URL is a credential that appears in every log, every referrer header and every REST response, and can never be revoked — so it is refused rather than documented`,
			)
		if (portal.filter !== undefined)
			errors.push(
				`${ctx}: filter is refused for scope "row" — the token names the row, and a second bound would be a second answer to which one`,
			)
		if (portal.layout !== 'detail')
			errors.push(
				`${ctx}: scope "row" requires layout "detail" — there is one row to render`,
			)
	} else if (portal.scope === 'collection') {
		if (portal.layout === 'detail')
			errors.push(
				`${ctx}: layout "detail" is refused for scope "collection" — a detail layout over many rows renders the first one and silently hides the rest`,
			)
	}

	const entity = system.data.entities.find((e) => e.id === portal.entityId)
	if (!entity) {
		errors.push(`${ctx}: unknown entity "${String(portal.entityId)}"`)
		return errors
	}
	// Checked against its OWNER entity, not merely against existence: a field id
	// from another entity resolves, and would project somebody else's column.
	const fieldsById = new Map(entity.fields.map((f) => [f.id, f]))
	const unauthenticated =
		portal.audience === 'public' || portal.audience === 'token'

	/** One field id, checked for existence, ownership and exposability. */
	const checkField = (fieldId: string, what: string): void => {
		const field = fieldsById.get(fieldId as PortalSpec['readFields'][number])
		if (!field) {
			errors.push(
				`${ctx}: ${what} "${String(fieldId)}" is not a field of entity "${portal.entityId}"`,
			)
			return
		}
		if (!unauthenticated) return
		if (field.type === 'file')
			errors.push(
				`${ctx}: ${what} "${field.name}" is a file field — it stores a STORAGE KEY, which is an object path rather than a value, so exposing it to a ${portal.audience} audience hands out a URL into the bucket. Serving a portal's images is a real capability and it is not this one`,
			)
		if (field.reference === USER_ENTITY_ID)
			errors.push(
				`${ctx}: ${what} "${field.name}" references e-user — it holds an identity-table primary key, and the one thing a ${portal.audience} surface must never become is a way to enumerate the people who have accounts`,
			)
	}

	const readFields = portal.readFields ?? []
	if (!Array.isArray(portal.readFields) || readFields.length === 0)
		errors.push(
			`${ctx}: readFields must name at least one field. There is deliberately no "expose everything" spelling and no exclusion list: an "all except" list silently exposes every field added AFTER it was written, which is the exact failure this layer exists to prevent`,
		)
	if (readFields.length > MAX_PORTAL_FIELDS)
		errors.push(
			`${ctx}: ${readFields.length} exposed fields exceeds the maximum of ${MAX_PORTAL_FIELDS} — past that the exposure report stops being something a reviewer reads before approving`,
		)
	const seenRead = new Set<string>()
	for (const fieldId of readFields) {
		if (seenRead.has(fieldId))
			errors.push(`${ctx}: readFields names "${fieldId}" twice`)
		seenRead.add(fieldId)
		checkField(fieldId, 'readFields')
	}

	// ---- the bound -----------------------------------------------------------
	if (portal.scope === 'collection') {
		const filter = portal.filter
		if (!filter || typeof filter !== 'object')
			errors.push(
				`${ctx}: scope "collection" requires a filter {fieldId, equals}. A collection portal is never unbounded — "the outside can list this table" is not a feature anybody means to ship`,
			)
		else {
			const field = fieldsById.get(filter.fieldId)
			if (!field)
				errors.push(
					`${ctx}: filter field "${String(filter.fieldId)}" is not a field of entity "${portal.entityId}"`,
				)
			else if (!portalFilterFieldTypes.includes(field.type))
				errors.push(
					`${ctx}: filter field "${field.name}" is a ${field.type} — a bound has to be an equality somebody can read, and only ${portalFilterFieldTypes.join(', ')} fields are. A date bound matches a microsecond; a json bound matches a serialization`,
				)
			else {
				const expected =
					field.type === 'number'
						? 'number'
						: field.type === 'boolean'
							? 'boolean'
							: 'string'
				if (typeof filter.equals !== expected)
					errors.push(
						`${ctx}: filter.equals is a ${typeof filter.equals} but "${field.name}" is a ${field.type} — a type-mismatched bound matches nothing in Postgres and everything in a reviewer's head`,
					)
			}
		}
	}

	// ---- the write surface ---------------------------------------------------
	const writes = portal.writes ?? []
	if (!Array.isArray(portal.writes))
		errors.push(
			`${ctx}: writes must be an array — pass [] for a read-only portal, which is the common case`,
		)
	const seenActions = new Set<string>()
	for (const write of writes) {
		if (!(PORTAL_WRITE_ACTIONS as readonly string[]).includes(write?.action)) {
			errors.push(
				`${ctx}: write action "${String(write?.action)}" is not one of ${PORTAL_WRITE_ACTIONS.join(', ')}. There is no "delete": it is not a declaration, not a spelling, and there is no path — see portalGrants`,
			)
			continue
		}
		if (seenActions.has(write.action))
			errors.push(
				`${ctx}: two "${write.action}" writes are declared — the second would silently win or silently lose depending on iteration order`,
			)
		seenActions.add(write.action)

		// The issue's gating bullet, made mechanical.
		if (write.action === 'update' && portal.audience === 'public')
			errors.push(
				`${ctx}: a public portal may not declare "update". Anonymous update means anyone on the internet may edit a row that already exists, and there is no honest product reason to spell that as a declaration. A client editing their own invoice is audience "token" — they have a link only they were sent, and it expires`,
			)
		if (write.action === 'create' && portal.scope === 'row')
			errors.push(
				`${ctx}: a row portal may not declare "create" — it reaches exactly one row, and a create reaches a row that does not exist yet, which is definitionally outside the bound`,
			)

		const fieldIds = write.fieldIds ?? []
		if (fieldIds.length === 0)
			errors.push(
				`${ctx}: the "${write.action}" write names no fields — opt-in per field, with no "all" and no "all except", so a write list with nothing in it writes nothing and should not be declared`,
			)
		if (fieldIds.length > MAX_PORTAL_FIELDS)
			errors.push(
				`${ctx}: the "${write.action}" write names ${fieldIds.length} fields, over the maximum of ${MAX_PORTAL_FIELDS}`,
			)
		const seenWrite = new Set<string>()
		for (const fieldId of fieldIds) {
			if (seenWrite.has(fieldId))
				errors.push(
					`${ctx}: the "${write.action}" write names "${fieldId}" twice`,
				)
			seenWrite.add(fieldId)
			checkField(fieldId, `the "${write.action}" write`)
			// The bound is server-stamped on create and immutable on update, exactly
			// as the tenant column is. A writable bound is a portal that can write
			// itself out of its own filter.
			if (portal.filter && fieldId === portal.filter.fieldId)
				errors.push(
					`${ctx}: the "${write.action}" write names the filter field "${fieldId}" — the bound is server-stamped on create and immutable on update, exactly as the tenant column is, because a writable bound is a portal that can write a row out of its own filter`,
				)
		}

		const rate = write.rateLimitPerHour
		if (typeof rate !== 'number' || !Number.isInteger(rate) || rate < 1)
			errors.push(
				`${ctx}: the "${write.action}" write needs an integer rateLimitPerHour ≥ 1. Required and never defaulted — writes from the outside are always budgeted, and how many an hour is acceptable belongs to whoever owns the table`,
			)
		else if (rate > MAX_PORTAL_WRITE_RATE)
			errors.push(
				`${ctx}: rateLimitPerHour ${rate} exceeds the maximum of ${MAX_PORTAL_WRITE_RATE}`,
			)
		else if (portal.audience === 'public' && rate > MAX_PUBLIC_WRITE_RATE)
			errors.push(
				`${ctx}: an unauthenticated write may not declare more than ${MAX_PUBLIC_WRITE_RATE} per hour (this declares ${rate}). Ten a minute is a comment form; past that the budget is the only thing standing between a public create and an unbounded row generator, and it has stopped standing`,
			)
	}

	return errors
}

/**
 * Everything wrong with one declared document template.
 *
 * Shared by `validateOp` and by {@link collectSpecSystemErrors} for the reason
 * `searchIndexErrors` and `sourceErrors` are: the shapes that must never be
 * *applied* are exactly the ones that must never be *loadable*, and a spec can
 * arrive by decoding a directory somebody hand-edited.
 *
 * What it is guarding is narrower than the search validator's job and worth
 * naming. Nothing here reaches SQL. What it reaches is **paper a customer
 * receives**: a placeholder that does not resolve prints `{number}` on an
 * invoice, a `json` field prints punctuation, and a `via` that is not actually
 * the foreign key back to this row prints somebody else's line items. Each of
 * those is silent at render time — the document comes out, it is just wrong —
 * which is why they are refused at declare time instead.
 *
 * `siblings` is every *other* declared template, so key uniqueness is enforced
 * here rather than only in the op. Two templates sharing a key would share a URL
 * and a stored object path, and the second one would overwrite the first's
 * archive.
 */
export function documentTemplateErrors(
	ctx: string,
	template: DocumentTemplateSpec,
	system: Pick<SpecSystem, 'data'>,
	siblings: readonly DocumentTemplateSpec[] = [],
): string[] {
	const errors: string[] = []

	if (typeof template.key !== 'string' || !DOCUMENT_KEY_RE.test(template.key))
		errors.push(
			`${ctx}: key "${String(template.key)}" must match ${DOCUMENT_KEY_RE.source}`,
		)
	else if (template.key.length > MAX_DOCUMENT_KEY_LENGTH)
		errors.push(
			`${ctx}: key "${template.key}" is ${template.key.length} characters — the maximum is ${MAX_DOCUMENT_KEY_LENGTH}, because the key becomes a URL segment and a stored object-key prefix`,
		)
	if (siblings.some((s) => s.id !== template.id && s.key === template.key))
		errors.push(
			`${ctx}: template key "${template.key}" is already declared — two templates with one key share a URL and a stored object path, so the second would overwrite the first's archive`,
		)
	if (!template.description?.trim())
		errors.push(
			`${ctx}: needs a description — a document nobody can explain is one nobody can decide to stop sending`,
		)
	if (!(DOCUMENT_PAGE_SIZES as readonly string[]).includes(template.pageSize))
		errors.push(
			`${ctx}: pageSize "${String(template.pageSize)}" is not one of ${DOCUMENT_PAGE_SIZES.join(', ')}`,
		)

	const entity = system.data.entities.find((e) => e.id === template.entityId)
	if (!entity) {
		errors.push(`${ctx}: unknown entity "${String(template.entityId)}"`)
		return errors
	}

	const sections = template.sections ?? []
	if (sections.length === 0)
		errors.push(
			`${ctx}: needs at least one section — a template with no sections renders a blank page`,
		)
	if (sections.length > MAX_DOCUMENT_SECTIONS)
		errors.push(
			`${ctx}: ${sections.length} sections exceeds the maximum of ${MAX_DOCUMENT_SECTIONS}`,
		)
	const slotNames = new Set<string>()
	sections.forEach((section, i) => {
		errors.push(
			...documentSectionErrors(
				`${ctx}: section ${i} (${String(section?.kind)})`,
				section,
				template,
				entity,
				system,
				slotNames,
			),
		)
	})

	errors.push(...documentDeliveryErrors(ctx, template.delivery, entity, system))
	return errors
}

/** Everything wrong with one section. Split out so the section list reads as a list. */
function documentSectionErrors(
	ctx: string,
	section: DocumentSection,
	template: DocumentTemplateSpec,
	entity: SpecSystem['data']['entities'][number],
	system: Pick<SpecSystem, 'data'>,
	slotNames: Set<string>,
): string[] {
	const errors: string[] = []
	if (!(DOCUMENT_SECTION_KINDS as readonly string[]).includes(section?.kind)) {
		errors.push(
			`${ctx}: unknown section kind "${String(section?.kind)}" (expected one of ${DOCUMENT_SECTION_KINDS.join(', ')})`,
		)
		return errors
	}

	/** Resolve a section's `fieldIds` against an entity, with the printable-type rule. */
	const resolveFieldIds = (
		ids: readonly string[],
		target: SpecSystem['data']['entities'][number],
		max: number,
	): string[] => {
		const out: string[] = []
		if (ids.length === 0)
			out.push(
				`${ctx}: needs at least one field — an empty block prints nothing`,
			)
		if (ids.length > max)
			out.push(`${ctx}: ${ids.length} fields exceeds the maximum of ${max}`)
		const byId = printableById(target)
		const seen = new Set<string>()
		for (const id of ids) {
			if (seen.has(id))
				out.push(`${ctx}: field "${id}" is listed twice — a field prints once`)
			seen.add(id)
			const meta = byId.get(id)
			if (!meta) {
				out.push(
					`${ctx}: "${id}" is not a field or derived value of entity "${target.id}"`,
				)
				continue
			}
			if (meta.kind === 'field' && !printableFieldTypes.includes(meta.type))
				out.push(
					`${ctx}: field "${meta.name}" is a ${meta.type} — only ${printableFieldTypes.join(', ')} fields have a printed form a person can read`,
				)
		}
		return out
	}

	switch (section.kind) {
		case 'heading': {
			if (section.level !== 1 && section.level !== 2)
				errors.push(`${ctx}: level must be 1 or 2`)
			if (!section.text?.trim()) errors.push(`${ctx}: needs text`)
			else
				errors.push(...placeholderErrors(ctx, 'heading', section.text, entity))
			break
		}
		case 'text': {
			if (!section.text?.trim()) errors.push(`${ctx}: needs text`)
			else errors.push(...placeholderErrors(ctx, 'text', section.text, entity))
			break
		}
		case 'fields': {
			if (section.columns !== 1 && section.columns !== 2)
				errors.push(`${ctx}: columns must be 1 or 2`)
			errors.push(
				...resolveFieldIds(
					section.fieldIds ?? [],
					entity,
					MAX_DOCUMENT_SECTION_FIELDS,
				),
			)
			if (section.caption)
				errors.push(
					...placeholderErrors(ctx, 'caption', section.caption, entity),
				)
			break
		}
		case 'table': {
			const over = system.data.entities.find((e) => e.id === section.over)
			if (!over) {
				errors.push(`${ctx}: unknown entity "${String(section.over)}"`)
				break
			}
			// `via` must be the foreign key on the many side pointing back at *this*
			// template's entity. Checking the target rather than only the existence
			// of the field is the whole point: a `via` that references some other
			// entity resolves, fetches rows, and prints somebody else's line items
			// under this customer's letterhead.
			const via = over.fields.find((f) => f.id === section.via)
			if (!via)
				errors.push(
					`${ctx}: via "${String(section.via)}" is not a field of entity "${over.id}"`,
				)
			else if (via.reference !== template.entityId)
				errors.push(
					`${ctx}: via "${via.name}" references ${via.reference ? `"${via.reference}"` : 'nothing'}, not "${template.entityId}" — via is the foreign key on the many side pointing back at this row, exactly as it is on a rollup`,
				)
			errors.push(
				...resolveFieldIds(
					section.fieldIds ?? [],
					over,
					MAX_DOCUMENT_TABLE_COLUMNS,
				),
			)
			if (section.orderBy !== undefined) {
				const order = over.fields.find((f) => f.id === section.orderBy)
				if (!order)
					errors.push(
						`${ctx}: orderBy "${section.orderBy}" is not a stored field of entity "${over.id}" — a derived value is computed on read, so ordering by one would order the page and not the query`,
					)
			}
			if (
				section.direction !== undefined &&
				section.direction !== 'asc' &&
				section.direction !== 'desc'
			)
				errors.push(`${ctx}: direction must be "asc" or "desc"`)
			if (section.caption)
				errors.push(
					...placeholderErrors(ctx, 'caption', section.caption, entity),
				)
			break
		}
		case 'rule':
			break
		case 'slot': {
			if (!/^[a-zA-Z][a-zA-Z0-9]*$/.test(section.name ?? ''))
				errors.push(
					`${ctx}: slot name "${String(section.name)}" must be an identifier — it is the key an owned module is registered under`,
				)
			else if (slotNames.has(section.name))
				errors.push(
					`${ctx}: slot "${section.name}" appears twice — one fill would render in two places with no way to tell them apart`,
				)
			else slotNames.add(section.name)
			break
		}
	}
	return errors
}

/** Everything wrong with a template's delivery declaration. */
function documentDeliveryErrors(
	ctx: string,
	delivery: DocumentDelivery,
	entity: SpecSystem['data']['entities'][number],
	system: Pick<SpecSystem, 'data'>,
): string[] {
	const errors: string[] = []
	if (!delivery || typeof delivery !== 'object') {
		errors.push(
			`${ctx}: needs a delivery declaration — "where does this go" is not a default`,
		)
		return errors
	}
	if (typeof delivery.download !== 'boolean')
		errors.push(`${ctx}: delivery.download must be true or false`)

	if (delivery.store) {
		if (!delivery.store.path?.trim())
			errors.push(`${ctx}: delivery.store needs a path`)
		else {
			errors.push(
				...placeholderErrors(
					ctx,
					'delivery.store.path',
					delivery.store.path,
					entity,
				),
			)
			// A path with no placeholder is one object key for every row: each
			// render overwrites the last, and the archive holds exactly one
			// document no matter how many were sent.
			if (documentPlaceholders(delivery.store.path).length === 0)
				errors.push(
					`${ctx}: delivery.store.path "${delivery.store.path}" has no {placeholder} — every row would write to the same object key, so the archive would hold one document however many were sent`,
				)
		}
		if (
			!(DOCUMENT_FORMATS as readonly string[]).includes(delivery.store.format)
		)
			errors.push(
				`${ctx}: delivery.store.format "${String(delivery.store.format)}" is not one of ${DOCUMENT_FORMATS.join(', ')}`,
			)
	}

	if (delivery.email) {
		if (!delivery.email.template?.trim())
			errors.push(
				`${ctx}: delivery.email needs a template — the name it is registered under in the email bundle`,
			)
		if (!delivery.email.subject?.trim())
			errors.push(`${ctx}: delivery.email needs a subject`)
		else
			errors.push(
				...placeholderErrors(
					ctx,
					'delivery.email.subject',
					delivery.email.subject,
					entity,
				),
			)
		if (
			!(DOCUMENT_FORMATS as readonly string[]).includes(delivery.email.format)
		)
			errors.push(
				`${ctx}: delivery.email.format "${String(delivery.email.format)}" is not one of ${DOCUMENT_FORMATS.join(', ')}`,
			)
		errors.push(
			...documentRecipientErrors(ctx, delivery.email.to, entity, system),
		)
	}
	return errors
}

/** Everything wrong with an email delivery's recipient path (one optional hop). */
function documentRecipientErrors(
	ctx: string,
	to: DocumentRecipient | undefined,
	entity: SpecSystem['data']['entities'][number],
	system: Pick<SpecSystem, 'data'>,
): string[] {
	const errors: string[] = []
	if (!to || typeof to !== 'object') {
		errors.push(
			`${ctx}: delivery.email needs a "to" — an outbound email with no declared recipient is the one thing this layer must never guess at`,
		)
		return errors
	}
	let target = entity
	if (to.via !== undefined) {
		const hop = entity.fields.find((f) => f.id === to.via)
		if (!hop) {
			errors.push(
				`${ctx}: delivery.email.to.via "${to.via}" is not a field of entity "${entity.id}"`,
			)
			return errors
		}
		if (!hop.reference) {
			errors.push(
				`${ctx}: delivery.email.to.via "${hop.name}" is not a reference — one hop means "follow this foreign key", and a plain column points at nothing to follow`,
			)
			return errors
		}
		const referenced = system.data.entities.find((e) => e.id === hop.reference)
		if (!referenced) {
			errors.push(
				`${ctx}: delivery.email.to.via "${hop.name}" references unknown entity "${hop.reference}"`,
			)
			return errors
		}
		target = referenced
	}
	const field = target.fields.find((f) => f.id === to.fieldId)
	if (!field)
		errors.push(
			`${ctx}: delivery.email.to.fieldId "${String(to.fieldId)}" is not a field of entity "${target.id}"`,
		)
	else if (field.type !== 'string')
		errors.push(
			`${ctx}: delivery.email.to "${field.name}" is a ${field.type} — an address is a string`,
		)
	return errors
}

/** Validate a spec system. Returns every problem found (empty = valid). */
export function collectSpecSystemErrors(system: SpecSystem): string[] {
	const errors: string[] = []

	// ---- product layer (delegate to the PRD validator) -----------------------
	try {
		validatePRD(system.product)
	} catch (err) {
		errors.push(err instanceof Error ? err.message : String(err))
	}

	const checkProvenance = (p: unknown, ctx: string) => {
		if (!provenanceSchema.safeParse(p).success)
			errors.push(`${ctx}: malformed provenance`)
	}

	// ---- data layer ----------------------------------------------------------
	const entityIds = new Set<string>()
	for (const entity of system.data.entities) {
		if (entityIds.has(entity.id))
			errors.push(`data: duplicate entity id "${entity.id}"`)
		entityIds.add(entity.id)
		checkProvenance(entity.provenance, `entity ${entity.id}`)
		const fieldIds = new Set<string>()
		for (const field of entity.fields) {
			if (fieldIds.has(field.id))
				errors.push(`entity ${entity.id}: duplicate field id "${field.id}"`)
			fieldIds.add(field.id)
			if (!(FIELD_TYPES as readonly string[]).includes(field.type))
				errors.push(
					`field ${field.id}: unknown type "${field.type}" (expected one of ${FIELD_TYPES.join(', ')})`,
				)
			checkProvenance(field.provenance, `field ${field.id}`)
		}
	}

	// ---- site layer ----------------------------------------------------------
	// Checked at the layer and not only at the op, on the schedule layer's
	// reasoning: a spec can also arrive by decoding a directory somebody
	// hand-edited, and a `site.json` holding `http://localhost:3000` is the one
	// shape that must never be loadable — it would put a canonical naming an
	// unreachable host on every page of the app.
	if (system.site !== undefined) errors.push(...siteErrors('site', system.site))

	// ---- access layer --------------------------------------------------------
	// Checked at the layer and not only at the op, on the rule every layer below
	// follows: a spec can also arrive by decoding a directory somebody
	// hand-edited. Here that rule is load-bearing rather than tidy — a spec whose
	// `access.json` names a role that no longer exists, under `default: "deny"`,
	// is an app that refuses requests for a reason nothing in it explains.
	if (system.access !== undefined) {
		const access = system.access
		if (access.default !== 'open' && access.default !== 'deny')
			errors.push(
				`access: default must be "open" or "deny", got "${String(access.default)}"`,
			)
		const entityNames = new Set(system.data.entities.map((e) => e.name))
		const roleKeys = new Set<string>()
		const roleIds = new Set<string>()
		for (const role of access.roles) {
			if (roleIds.has(role.id))
				errors.push(`access: duplicate role id "${role.id}"`)
			roleIds.add(role.id)
			if (roleKeys.has(role.key))
				errors.push(`access: duplicate role key "${role.key}"`)
			roleKeys.add(role.key)
			if (!ACCESS_KEY_RE.test(role.key))
				errors.push(
					`role ${role.id}: key "${role.key}" must match ${ACCESS_KEY_RE.source}`,
				)
			checkProvenance(role.provenance, `role ${role.id}`)
			errors.push(
				...roleGrantErrors(`role ${role.id}`, role.grants, entityNames),
			)
		}
		const groupKeys = new Set<string>()
		const groupIds = new Set<string>()
		for (const group of access.groups) {
			if (groupIds.has(group.id))
				errors.push(`access: duplicate group id "${group.id}"`)
			groupIds.add(group.id)
			if (groupKeys.has(group.key))
				errors.push(`access: duplicate group key "${group.key}"`)
			groupKeys.add(group.key)
			if (!ACCESS_KEY_RE.test(group.key))
				errors.push(
					`group ${group.id}: key "${group.key}" must match ${ACCESS_KEY_RE.source}`,
				)
			checkProvenance(group.provenance, `group ${group.id}`)
		}
		const bindingIds = new Set<string>()
		for (const binding of access.bindings) {
			if (bindingIds.has(binding.id))
				errors.push(`access: duplicate binding id "${binding.id}"`)
			bindingIds.add(binding.id)
			if (!roleKeys.has(binding.role))
				errors.push(`binding ${binding.id}: undeclared role "${binding.role}"`)
			const known =
				binding.principal.kind === 'group'
					? groupKeys.has(binding.principal.key)
					: roleKeys.has(binding.principal.key)
			if (!known)
				errors.push(
					`binding ${binding.id}: undeclared ${binding.principal.kind} "${binding.principal.key}"`,
				)
			checkProvenance(binding.provenance, `binding ${binding.id}`)
		}
		errors.push(...bindingCycleErrors('access', access.bindings))
	}

	// ---- flag layer ----------------------------------------------------------
	// Validated before the page layer so a page's gate can be resolved against
	// the set of keys that actually exist.
	const flagKeys = new Set<string>()
	const flagIds = new Set<string>()
	for (const flag of system.flags?.flags ?? []) {
		if (flagIds.has(flag.id))
			errors.push(`flags: duplicate flag id "${flag.id}"`)
		flagIds.add(flag.id)
		if (flagKeys.has(flag.key))
			errors.push(`flags: duplicate flag key "${flag.key}"`)
		flagKeys.add(flag.key)
		if (!FLAG_KEY_RE.test(flag.key))
			errors.push(
				`flag ${flag.id}: key "${flag.key}" must match ${FLAG_KEY_RE.source}`,
			)
		checkProvenance(flag.provenance, `flag ${flag.id}`)
		const percent = flag.targeting?.rolloutPercent
		if (
			percent !== undefined &&
			(!Number.isInteger(percent) ||
				percent < 0 ||
				percent > MAX_ROLLOUT_PERCENT)
		)
			errors.push(
				`flag ${flag.id}: rolloutPercent ${percent} is not an integer in 0–${MAX_ROLLOUT_PERCENT}`,
			)
		if (flag.default && flag.targeting)
			errors.push(
				`flag ${flag.id}: targeting cannot narrow a flag whose default is already true`,
			)
	}

	// ---- schedule layer ------------------------------------------------------
	// Everything here is checked at the layer rather than only at the op, because
	// a spec can also arrive by decoding a directory somebody hand-edited — and a
	// schedule with no `runAs` is the one shape that must never be loadable.
	const scheduleIds = new Set<string>()
	const scheduleKeys = new Set<string>()
	for (const schedule of system.schedules?.schedules ?? []) {
		const ctx = `schedule ${schedule.id}`
		if (scheduleIds.has(schedule.id))
			errors.push(`schedules: duplicate schedule id "${schedule.id}"`)
		scheduleIds.add(schedule.id)
		if (scheduleKeys.has(schedule.key))
			errors.push(`schedules: duplicate schedule key "${schedule.key}"`)
		scheduleKeys.add(schedule.key)
		if (!SCHEDULE_KEY_RE.test(schedule.key))
			errors.push(
				`${ctx}: key "${schedule.key}" must match ${SCHEDULE_KEY_RE.source}`,
			)
		if (!schedule.description?.trim())
			errors.push(`${ctx}: needs a description`)
		if (!isValidTimezone(schedule.timezone))
			errors.push(`${ctx}: unknown timezone "${schedule.timezone}"`)
		errors.push(...recurrenceErrors(ctx, schedule.recurrence))
		errors.push(...runAsErrors(ctx, schedule.runAs))
		if (schedule.entityId && !entityIds.has(schedule.entityId))
			errors.push(`${ctx}: unknown entity "${schedule.entityId}"`)
		checkProvenance(schedule.provenance, ctx)
	}

	// ---- source layer --------------------------------------------------------
	// After the data and schedule layers, because a source resolves against both.
	const sourceIds = new Set<string>()
	const sourceKeys = new Set<string>()
	for (const source of system.sources?.sources ?? []) {
		const ctx = `source ${source.id}`
		if (sourceIds.has(source.id))
			errors.push(`sources: duplicate source id "${source.id}"`)
		sourceIds.add(source.id)
		if (sourceKeys.has(source.key))
			errors.push(`sources: duplicate source key "${source.key}"`)
		sourceKeys.add(source.key)
		errors.push(...sourceErrors(ctx, source, system))
		checkProvenance(source.provenance, ctx)
	}

	// ---- search layer --------------------------------------------------------
	// After the data layer, because an index resolves its fields against it.
	const searchIds = new Set<string>()
	const searchKeys = new Set<string>()
	const indexes = system.search?.indexes ?? []
	for (const index of indexes) {
		const ctx = `search index ${index.id}`
		if (searchIds.has(index.id))
			errors.push(`search: duplicate index id "${index.id}"`)
		searchIds.add(index.id)
		if (searchKeys.has(index.key))
			errors.push(`search: duplicate index key "${index.key}"`)
		searchKeys.add(index.key)
		errors.push(...searchIndexErrors(ctx, index, system, indexes))
		checkProvenance(index.provenance, ctx)
	}

	// ---- documents layer -----------------------------------------------------
	// After the data layer, because a template resolves its sections, its
	// relations and its recipient path against it.
	const templateIds = new Set<string>()
	const templateKeys = new Set<string>()
	const templates = system.documents?.templates ?? []
	for (const template of templates) {
		const ctx = `document template ${template.id}`
		if (templateIds.has(template.id))
			errors.push(`documents: duplicate template id "${template.id}"`)
		templateIds.add(template.id)
		if (templateKeys.has(template.key))
			errors.push(`documents: duplicate template key "${template.key}"`)
		templateKeys.add(template.key)
		errors.push(...documentTemplateErrors(ctx, template, system, templates))
		checkProvenance(template.provenance, ctx)
	}

	// ---- imports layer -------------------------------------------------------
	// After the data layer, because an importer resolves its columns and its
	// upsert key against it.
	const importerIds = new Set<string>()
	const importerKeys = new Set<string>()
	const importers = system.imports?.importers ?? []
	for (const importer of importers) {
		const ctx = `importer ${importer.id}`
		if (importerIds.has(importer.id))
			errors.push(`imports: duplicate importer id "${importer.id}"`)
		importerIds.add(importer.id)
		if (importerKeys.has(importer.key))
			errors.push(`imports: duplicate importer key "${importer.key}"`)
		importerKeys.add(importer.key)
		errors.push(...importerErrors(ctx, importer, system, importers))
		checkProvenance(importer.provenance, ctx)
	}

	// ---- portals layer -------------------------------------------------------
	// After the data layer, because a portal resolves its projection, its bound
	// and its write surface against it.
	const portalIds = new Set<string>()
	const portalKeys = new Set<string>()
	const portals = system.portals?.portals ?? []
	for (const portal of portals) {
		const ctx = `portal ${portal.id}`
		if (portalIds.has(portal.id))
			errors.push(`portals: duplicate portal id "${portal.id}"`)
		portalIds.add(portal.id)
		if (portalKeys.has(portal.key))
			errors.push(`portals: duplicate portal key "${portal.key}"`)
		portalKeys.add(portal.key)
		errors.push(...portalErrors(ctx, portal, system, portals))
		checkProvenance(portal.provenance, ctx)
	}

	// ---- live layer ----------------------------------------------------------
	// After the data layer, because a subscription resolves its projection and
	// its bound against an entity's fields.
	const liveIds = new Set<string>()
	const liveKeys = new Set<string>()
	const subscriptions = system.live?.subscriptions ?? []
	for (const sub of subscriptions) {
		const ctx = `live ${sub.id}`
		if (liveIds.has(sub.id))
			errors.push(`live: duplicate subscription id "${sub.id}"`)
		liveIds.add(sub.id)
		if (liveKeys.has(sub.key))
			errors.push(`live: duplicate live key "${sub.key}"`)
		liveKeys.add(sub.key)
		errors.push(...liveSubscriptionErrors(ctx, sub, system, subscriptions))
		checkProvenance(sub.provenance, ctx)
	}

	// ---- view layer ----------------------------------------------------------
	// After the data layer, because an action resolves its write set and its
	// chosen field against an entity's fields.
	const actionIds = new Set<string>()
	const actionKeys = new Set<string>()
	const actions = system.view?.actions ?? []
	for (const action of actions) {
		const ctx = `action ${action.id}`
		if (actionIds.has(action.id))
			errors.push(`view: duplicate action id "${action.id}"`)
		actionIds.add(action.id)
		if (actionKeys.has(action.key))
			errors.push(`view: duplicate action key "${action.key}"`)
		actionKeys.add(action.key)
		errors.push(...actionErrors(ctx, action, system, actions))
		checkProvenance(action.provenance, ctx)
	}

	// ---- page layer ----------------------------------------------------------
	const pageIds = new Set<string>()
	for (const page of system.pages.pages) {
		if (pageIds.has(page.id))
			errors.push(`pages: duplicate page id "${page.id}"`)
		pageIds.add(page.id)
		checkProvenance(page.provenance, `page ${page.id}`)
		if (page.entityId !== undefined && !entityIds.has(page.entityId))
			errors.push(
				`page ${page.id}: entityId -> unknown entity "${page.entityId}"`,
			)
		if (page.flag !== undefined && !flagKeys.has(page.flag))
			errors.push(`page ${page.id}: flag -> undeclared flag "${page.flag}"`)
		const blockIds = new Set<string>()
		for (const block of page.blocks) {
			if (blockIds.has(block.id))
				errors.push(`page ${page.id}: duplicate block id "${block.id}"`)
			blockIds.add(block.id)
			checkProvenance(block.provenance, `block ${block.id}`)
			if (
				block.variant !== undefined &&
				!(BLOCK_VARIANTS as readonly string[]).includes(block.variant)
			)
				errors.push(
					`block ${block.id}: unknown variant "${block.variant}" (expected one of ${BLOCK_VARIANTS.join(', ')})`,
				)
			if (block.flag !== undefined && !flagKeys.has(block.flag))
				errors.push(
					`block ${block.id}: flag -> undeclared flag "${block.flag}"`,
				)
		}
	}

	// ---- pricing layer -------------------------------------------------------
	const tierIds = new Set<string>()
	for (const tier of system.pricing.tiers) {
		if (tierIds.has(tier.id))
			errors.push(`pricing: duplicate tier id "${tier.id}"`)
		tierIds.add(tier.id)
		checkProvenance(tier.provenance, `tier ${tier.id}`)
	}

	// ---- theme layer ---------------------------------------------------------
	if (system.theme !== undefined) {
		const t = system.theme
		const inSet = (
			value: string | undefined,
			set: readonly string[],
			key: string,
		) => {
			if (value !== undefined && !set.includes(value))
				errors.push(
					`theme: unknown ${key} "${value}" (expected one of ${set.join(', ')})`,
				)
		}
		inSet(t.preset, THEME_PRESETS, 'preset')
		inSet(t.radius, THEME_RADII, 'radius')
		inSet(t.density, THEME_DENSITIES, 'density')
		inSet(t.font, THEME_FONTS, 'font')
		inSet(t.typeScale, THEME_TYPE_SCALES, 'typeScale')
		if (t.accent !== undefined && !ACCENT_RE.test(t.accent))
			errors.push(`theme: accent "${t.accent}" is not a #rgb/#rrggbb hex color`)
	}

	// ---- decision ledger -----------------------------------------------------
	errors.push(...validateLedger(system.ledger))

	// ---- op-log attribution -------------------------------------
	// The op log is the audit trail, and a malformed attribution record is worse
	// than an absent one: it reads as an answer. An *absent* actor is legal (an
	// entry written before #200 genuinely has none — see `AppliedOp.actor`), but a
	// present one has to be the real shape, so a hand-edited or hand-merged
	// `spec.json` cannot smuggle in a surface that does not exist.
	for (const entry of system.opLog) {
		if (entry.actor === undefined) continue
		if (!opActorSchema.safeParse(entry.actor).success)
			errors.push(
				`op-log ${entry.id}: malformed actor (surface must be one of ${OP_SURFACES.join(', ')}; agent/session/keyId/path must be non-empty strings)`,
			)
	}

	return errors
}

/** Validate a spec system, throwing a combined Error on any problem. */
export function validateSpecSystem(system: SpecSystem): SpecSystem {
	const errors = collectSpecSystemErrors(system)
	if (errors.length)
		throw new Error(
			`Spec system validation failed (${errors.length}):\n- ${errors.join('\n- ')}`,
		)
	return system
}
