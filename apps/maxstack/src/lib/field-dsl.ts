/**
 * The terminal-native field DSL behind `maxstack add-entity` / `add-field`
 *. Hand-authoring op JSON is the honest wire format an agent emits,
 * but a human should not type nested `args.entity.fields[]` by hand. This
 * compiles a compact `name:type!` grammar down to the exact same
 * `data.addEntity` / `data.addField` ops — the JSON stays the underlying
 * primitive; the terminal gets sugar.
 *
 * Grammar (one per `--field`):
 *
 *     name:type[!]
 *
 *   - trailing `!` marks the field required.
 *   - `type` is one of the aliases below, or `enum(a,b,c)` for a choice list,
 *     or `ref:<entityId>` / `-><entityId>` for a belongs-to reference.
 *
 * Examples:
 *
 *     title:text!                   required string
 *     done:bool                     optional boolean
 *     'priority:enum(low,med,high)' enum with three options
 *     author:ref:e-user             belongs-to FK onto e-user
 *     'author:->e-user'             the same FK, arrow spelling
 *
 * Quote anything carrying `(` or `->`: both are shell syntax, and unquoted
 * `->e-user` is a redirect that silently mangles the argument.
 */

import type {
	EntityId,
	EntitySpec,
	FieldSpec,
	FieldType,
	PageSpec,
} from '@maxstack/spec'
import { accept, manual, suggested } from '@maxstack/spec'
import type { OpOrigin } from './origin.ts'

/**
 * The provenance the sugar stamps on the rows it builds, by author.
 * `human` → {@link manual}: accepted and regen-protected, matching
 * hand-authored intent. `ai` → an *accepted* {@link suggested} row: it goes
 * live immediately (applying the op is the accept half of suggest→accept) while
 * `isSuggested` keeps the agent authorship visible in the review surfaces.
 * This mirrors `defaultProvenance` in the op layer, which the DSL bypasses by
 * stamping provenance explicitly.
 */
function provenanceFor(origin: OpOrigin) {
	return origin === 'human' ? manual() : accept(suggested())
}

/** Type-name aliases → the canonical {@link FieldType}. */
const TYPE_ALIASES: Record<string, FieldType> = {
	text: 'string',
	string: 'string',
	str: 'string',
	number: 'number',
	num: 'number',
	int: 'number',
	integer: 'number',
	float: 'number',
	bool: 'boolean',
	boolean: 'boolean',
	date: 'date',
	datetime: 'date',
	timestamp: 'date',
	json: 'json',
	object: 'json',
}

/**
 * The alias table, exposed for the drift check in `commands/start.test.ts`.
 * `@maxstack/spec-derive`'s blueprint compiler mirrors this list to reject a
 * model-invented type *before* {@link parseField} would throw mid-scaffold
 *; the two are asserted equal so the mirror cannot rot.
 */
export const TYPE_ALIASES_FOR_TEST: Readonly<Record<string, FieldType>> =
	TYPE_ALIASES

/** A JS-identifier-shaped slug — what both entity ids (`e-<slug>`) and field
 * ids (`fld-<entity>-<slug>`) are built from. camelCase is allowed (`dueOn`,
 * `renewsOn`); the leading char must be a lowercase letter so generated ids
 * stay clean. */
const SLUG_RE = /^[a-z][a-zA-Z0-9]*$/

function assertSlug(kind: string, value: string): void {
	if (!SLUG_RE.test(value)) {
		throw new Error(
			`invalid ${kind} "${value}" — use an identifier starting with a lowercase letter (e.g. task, dueOn)`,
		)
	}
}

/** The `e-`-prefixed branded entity id for a slug. */
export function entityIdFor(slug: string): EntityId {
	return `e-${slug}`
}

/**
 * Parse one `--field` spec (`name:type[!]`) into a {@link FieldSpec}. The field
 * id is namespaced under the owning entity slug so two entities can carry a
 * same-named field without an id collision (mirrors the bundle codemods).
 */
export function parseField(
	entitySlug: string,
	spec: string,
	origin: OpOrigin = 'human',
): FieldSpec {
	const bang = spec.endsWith('!')
	const body = bang ? spec.slice(0, -1) : spec
	const colon = body.indexOf(':')
	if (colon <= 0) {
		throw new Error(
			`bad --field "${spec}" — expected name:type (e.g. title:text!, priority:enum(low,high))`,
		)
	}
	const name = body.slice(0, colon).trim()
	const typeExpr = body.slice(colon + 1).trim()
	assertSlug('field name', name)

	const base = {
		id: `fld-${entitySlug}-${name}` as FieldSpec['id'],
		name,
		required: bang,
		provenance: provenanceFor(origin),
	}

	// enum(a,b,c) — an inline option list.
	const enumMatch = typeExpr.match(/^enum\((.*)\)$/)
	if (enumMatch) {
		const values = enumMatch[1]!
			.split(',')
			.map((v) => v.trim())
			.filter(Boolean)
		if (values.length === 0) {
			throw new Error(`enum field "${name}" needs at least one option`)
		}
		return {
			...base,
			type: 'enum',
			options: values.map((value) => ({ label: value, value })),
		}
	}

	// ref:e-user or ->e-user — a belongs-to foreign key.
	const refMatch = typeExpr.match(/^(?:ref:|->)(.+)$/)
	if (refMatch) {
		const target = refMatch[1]!.trim()
		if (!target.startsWith('e-')) {
			throw new Error(
				`reference field "${name}" must target an entity id (e-…), got "${target}"`,
			)
		}
		return { ...base, type: 'string', reference: target as EntityId }
	}

	// A bare `-` is what the shell leaves behind when `->e-other` was passed
	// unquoted: `name:->e-other` parses as the word `name:-` plus the redirect
	// `>e-other`, which also drops an empty file of that name in the cwd
	//. Naming the mangled type alone sends the reader hunting for
	// a type that was never typed, so say what actually happened.
	if (typeExpr === '-') {
		throw new Error(
			`field "${name}" looks like an unquoted "->" reference — the shell read it as a redirect (and wrote an empty file named after the target). Quote the argument: --field '${name}:->e-<entity>'`,
		)
	}

	const type = TYPE_ALIASES[typeExpr.toLowerCase()]
	if (!type) {
		const known = [...new Set(Object.values(TYPE_ALIASES))].join(', ')
		throw new Error(
			`unknown field type "${typeExpr}" for "${name}" — use ${known}, enum(...), or ref:<entityId>`,
		)
	}
	return { ...base, type }
}

/**
 * Build a whole {@link EntitySpec} from a slug + display name + `--field`
 * specs. Human-authored, so the entity and every field carry `manual()`
 * provenance — accepted and protected from regeneration, matching what the
 * feature-bundle codemods emit.
 */
export function buildEntity(
	slug: string,
	name: string,
	fieldSpecs: string[],
	origin: OpOrigin = 'human',
): EntitySpec {
	assertSlug('entity id', slug)
	const fields = fieldSpecs.map((f) => parseField(slug, f, origin))
	const seen = new Set<string>()
	for (const f of fields) {
		if (seen.has(f.name)) {
			throw new Error(`duplicate field "${f.name}" on entity "${slug}"`)
		}
		seen.add(f.name)
	}
	return {
		id: entityIdFor(slug),
		name,
		fields,
		provenance: provenanceFor(origin),
	}
}

/** Title-case a slug for a default display name (`task` → `Task`). */
export function titleCase(slug: string): string {
	return slug.charAt(0).toUpperCase() + slug.slice(1)
}

/**
 * Build a default list {@link PageSpec} for an entity slug — the sugar behind
 * `maxstack add-page <entity>`. Mirrors how `add view` derives a
 * route (`/<slug>`, no pluralization) and how `buildEntity` stamps human
 * authorship: the page and its single `table` block carry `manual()`
 * provenance, so they land accepted and survive regeneration.
 *
 * Every default is overridable so the sugar never boxes you in:
 *   maxstack add-page task --route /today --name Today --id pg-today
 */
export function buildPage(
	slug: string,
	overrides: { name?: string; route?: string; id?: string } = {},
	origin: OpOrigin = 'human',
): PageSpec {
	assertSlug('entity id', slug)
	const id = (overrides.id ?? `pg-${slug}`) as PageSpec['id']
	return {
		id,
		name: overrides.name ?? titleCase(slug),
		route: overrides.route ?? `/${slug}`,
		entityId: entityIdFor(slug),
		blocks: [
			{
				id: `blk-${slug}-table` as PageSpec['blocks'][number]['id'],
				type: 'table',
				provenance: provenanceFor(origin),
			},
		],
		provenance: provenanceFor(origin),
	}
}
