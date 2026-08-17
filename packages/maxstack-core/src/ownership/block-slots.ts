/**
 * **Block-level slots** (parent #163) — the honest half of the
 * expressibility story.
 *
 * Three corpus asks should *stay* bespoke: gymlog's animated exercise demos,
 * cardstack's card-flip study mode, todotracker's home-screen widget. Absorbing
 * them into typed ops is how a framework becomes a cage. The platform's job is
 * to make them **cost 3 instead of 5** — and until now it could not, because
 * the only slot seam was page-level: wanting one custom card meant ejecting the
 * whole surface and giving up every derivation you *did* want.
 *
 * A block slot is a **derived** seam. Nothing is declared in the spec: every
 * page that renders a resource exposes the same fixed set of slot-bearing block
 * roles, and a slot is "filled" the moment the resource's user-owned
 * `*.slots.tsx` exports a function under the derived id. The generated region
 * around it keeps regenerating.
 *
 * ## Slot ids are a public API
 *
 * Once a maintainer has written into `exercise__row`, renaming it is a breaking
 * change. So the id derives from **stable spec identity** — the resource, the
 * block role, and (for parameterized roles) the field name — and never from
 * generation order, block array index, or block id. Reordering a page's blocks,
 * adding a field, or installing a bundle cannot move an existing slot.
 *
 * ## Proliferation is bounded on purpose
 *
 * "Every block is a slot" would be a permanently-stable API surface the size of
 * the renderer. Two things keep it small:
 *
 *   1. {@link BLOCK_SLOT_ROLES} is a *declared, versioned* list. A role that is
 *      not on it has no slot, and the list is versioned
 *      ({@link BLOCK_SLOT_ROLES_VERSION}) so additions are a visible event.
 *   2. Block slots are **available, not scaffolded**. The generator never writes
 *      a stub for one — `maxstack slots` lists them and `maxstack slots fill`
 *      writes the one you asked for. A project that fills nothing carries no
 *      extra bytes, and the slot file stays as small as what the user owns.
 */

/**
 * The version of the slot-bearing role list. Bump when {@link BLOCK_SLOT_ROLES}
 * changes: a role added here is a new permanent public API surface, and a role
 * removed is a breaking change for anyone who filled it. `maxstack slots
 * --json` reports it so a project can tell which vocabulary it was authored
 * against.
 *
 * Bump it for a **props** change too. `maxstack drift` reads it to say *"the
 * props a slot is called with may have changed"* — which is exactly what a v1
 * `list` fill needs to hear, even though nothing about it broke.
 *
 * - **v2** — the `list` slot became a controller (#398): it is now handed the
 *   declared actions and their runner, the selection, the ordering the loader
 *   honoured, and the inline edit/create handlers, alongside the rows it
 *   already got. Purely additive; a v1 fill keeps working and keeps ignoring
 *   them, which is the point of telling its author.
 */
export const BLOCK_SLOT_ROLES_VERSION = 2

/** A slot-bearing block role. */
export type BlockSlotRole = 'header' | 'list' | 'row' | 'field' | 'empty'

export interface BlockSlotRoleDef {
	role: BlockSlotRole
	/**
	 * Whether the role names one *instance* of a repeated block and therefore
	 * takes a parameter. Only `field` does today: a page has one header and one
	 * list, but N fields, and each is separately replaceable.
	 */
	parameterized: boolean
	/** What filling this slot takes over, in one line — the CLI prints it. */
	description: string
	/** The typed props the slot component is called with (a `@maxstack/ui` type). */
	props: string
}

/**
 * **The declared slot-bearing block roles, v1.**
 *
 * Deliberately the roles the runtime *actually renders today*, not the roles a
 * renderer might grow. Board cards, calendar entries, detail panels and form
 * sections are named in #178's scope but have no generated block behind them
 * yet; publishing ids for regions nobody renders would freeze an API against a
 * shape we have not built. They join this list — with a version bump — when
 * their blocks land.
 */
export const BLOCK_SLOT_ROLES: readonly BlockSlotRoleDef[] = [
	{
		role: 'header',
		parameterized: false,
		description:
			'The page header region (title + primary action). The nav frame, data loading and list below keep regenerating.',
		props: 'HeaderSlotProps',
	},
	{
		role: 'list',
		parameterized: false,
		description:
			'The whole list region — a bespoke player, board, or widget in place of the generated table/cards/feed. Rows, references and files arrive already resolved, and so do the declared actions, the selection, the ordering and the inline edit/create handlers: you replace the rendering, not the write path.',
		props: 'ListSlotProps',
	},
	{
		role: 'row',
		parameterized: false,
		description:
			'One row/card/entry inside the generated list. The list keeps its ordering, empty state and chrome.',
		props: 'RowSlotProps',
	},
	{
		role: 'field',
		parameterized: true,
		description:
			'One field cell rendering, everywhere the list renders it. Takes the field name.',
		props: 'FieldSlotProps',
	},
	{
		role: 'empty',
		parameterized: false,
		description: 'The empty state shown when the resource has no rows yet.',
		props: 'EmptySlotProps',
	},
] as const

const ROLE_BY_NAME = new Map(BLOCK_SLOT_ROLES.map((r) => [r.role, r]))

/**
 * The separator between id segments. Two underscores, and {@link segment}
 * guarantees no single segment ever contains one, so the boundary is
 * unambiguous however a resource or field is named.
 */
const SEP = '__'

/**
 * The one-line explanation of {@link segment}, carried on every surface that
 * hands an id to someone (`maxstack slots`, `query_spec {section:"slots"}`, the
 * workbench pane). Without it `reading-item` producing `reading_ditem__header`
 * reads as a mangling bug — it was filed as one (#378) — and the likelier
 * reaction, renaming the entity to dodge an "ugly" id, is the worse outcome.
 * The *reason* is the load-bearing half, so it ships with the map.
 */
export const BLOCK_SLOT_ID_ESCAPING =
	'Ids are escaped to legal JS identifiers: `-` → `_d`, `_` → `_u`, any other illegal character → `_z` (so `reading-item` gives `reading_ditem__header`). The escape is reversible rather than a fold, so two differently-spelled resources can never collide on one id — this is correct, do not rename a resource to avoid it.'

/**
 * Make one id segment a safe JS identifier fragment. Slot ids are *exported
 * function names* in the user's slot file, so `reading-item` has to become a
 * legal identifier.
 *
 * The encoding is escaped rather than a lossy fold, because folding `-` to `_`
 * would let the resources `read-item` and `read_item` produce the same id — and
 * two resources sharing one slot id is a public API that silently means
 * different things in different projects. `_` is the escape character (escaped
 * as `_u`), `-` becomes `_d`, and any other illegal character becomes `_z`. In
 * practice resources are kebab-case and fields camelCase, so only `_d` ever
 * fires; the rest exists so the mapping is injective.
 */
function segment(raw: string): string {
	let out = ''
	for (const ch of raw) {
		if (ch === '_') out += '_u'
		else if (ch === '-') out += '_d'
		else if (/[A-Za-z0-9]/.test(ch)) out += ch
		else out += '_z'
	}
	return out
}

/**
 * Inverse of {@link segment}. A left-to-right scan, not sequential
 * `String.replace` passes — those re-consume their own output, which is how a
 * naive decoder maps two distinct resources back onto one name. `_z` is lossy
 * by construction (it stands for any illegal character) and decodes to `-`,
 * which is what such a resource would have been slugged to anyway.
 */
function unsegment(seg: string): string {
	let out = ''
	for (let i = 0; i < seg.length; i++) {
		const ch = seg[i]
		if (ch !== '_') {
			out += ch
			continue
		}
		i += 1
		out += seg[i] === 'u' ? '_' : '-'
	}
	return out
}

export interface BlockSlotRef {
	/** The Sprout resource id, e.g. `exercise` (never the `e-` prefixed entity id). */
	resource: string
	role: BlockSlotRole
	/** The field name, for parameterized roles (`field`). */
	field?: string
}

/**
 * **The one canonical block-slot id.** `exercise` + `row` → `exercise__row`;
 * `task` + `field` + `dueDate` → `task__field__dueDate`.
 *
 * Derived from spec identity alone. Note what is *not* in it: no block id, no
 * array index, no page route, no generation counter. A page whose blocks are
 * reordered, a bundle installed after the fact, or a route renamed all leave
 * every existing id exactly where it was — which is the whole reason a
 * maintainer can safely write code against one.
 */
export function blockSlotId(ref: BlockSlotRef): string {
	const def = ROLE_BY_NAME.get(ref.role)
	if (!def) throw new Error(`unknown block slot role: ${ref.role}`)
	if (def.parameterized) {
		if (!ref.field)
			throw new Error(`block slot role '${ref.role}' requires a field name`)
		return [segment(ref.resource), ref.role, segment(ref.field)].join(SEP)
	}
	if (ref.field)
		throw new Error(`block slot role '${ref.role}' takes no field name`)
	return [segment(ref.resource), ref.role].join(SEP)
}

/**
 * Parse a block-slot id back to its parts, or `null` when the name is not one —
 * which is how a page-level `slot:<name>` export living in the same file is
 * told apart from a block slot, without a second registry to keep in sync.
 */
export function parseBlockSlotId(id: string): BlockSlotRef | null {
	const parts = id.split(SEP)
	const role = parts[1]
	const def = role ? ROLE_BY_NAME.get(role as BlockSlotRole) : undefined
	if (!def || !parts[0]) return null
	if (parts.length === 2 && !def.parameterized)
		return { resource: unsegment(parts[0]), role: def.role }
	if (parts.length === 3 && def.parameterized && parts[2])
		return {
			resource: unsegment(parts[0]),
			role: def.role,
			field: unsegment(parts[2]),
		}
	return null
}

/** Whether an exported name from a slot file is a block-slot id. */
export function isBlockSlotId(id: string): boolean {
	return parseBlockSlotId(id) !== null
}

export interface BlockSlotDescriptor extends BlockSlotRef {
	/** The stable id — the export name in `<resource>.slots.tsx`. */
	id: string
	/** The `@maxstack/ui` props type the slot component receives. */
	props: string
	description: string
}

/**
 * Every block slot available on one resource's page: the unparameterized roles,
 * plus one `field` slot per rendered field.
 *
 * `fields` is what the page actually renders (the block's `fields` selection,
 * else the resource's visible columns) — a slot is only offered for a field
 * that is on screen, because a slot for a field nobody renders is an API
 * promise with no host block behind it, which is exactly the dangling case the
 * gate exists to catch.
 */
export function blockSlotsForResource(
	resource: string,
	fields: readonly string[] = [],
): BlockSlotDescriptor[] {
	const out: BlockSlotDescriptor[] = []
	for (const def of BLOCK_SLOT_ROLES) {
		if (!def.parameterized) {
			out.push({
				id: blockSlotId({ resource, role: def.role }),
				resource,
				role: def.role,
				props: def.props,
				description: def.description,
			})
			continue
		}
		for (const field of fields) {
			out.push({
				id: blockSlotId({ resource, role: def.role, field }),
				resource,
				role: def.role,
				field,
				props: def.props,
				description: `${def.description} (${field})`,
			})
		}
	}
	return out
}

/**
 * The typed stub for one block slot — what `maxstack slots fill` appends to the
 * resource's slot file.
 *
 * The signature is the point. A slot author gets the same field knowledge the
 * generated renderer has (`props.columns` carries the `withMeta` metadata:
 * labels, formats, enum members, hidden flags), rather than re-deriving it from
 * the row object. That is the difference between a slot fill and an eject — the
 * platform hands over the rendering and keeps the derivation.
 */
export function emitBlockSlotStub(descriptor: BlockSlotDescriptor): string {
	const { id, props, role } = descriptor
	return [
		`// Block slot \`${id}\` — yours. ${descriptor.description}`,
		'// The generator created this once and will never overwrite it.',
		`export function ${id}(props: ${props}) {`,
		'\tvoid props',
		`\treturn <p>Block slot \`${id}\` (${role}) — implement this in this file.</p>`,
		'}',
	].join('\n')
}

/** The import line a slot file needs for the props types it references. */
export function blockSlotPropsImport(
	descriptors: readonly BlockSlotDescriptor[],
): string {
	const types = [...new Set(descriptors.map((d) => d.props))].sort()
	return `import type { ${types.join(', ')} } from '@maxstack/ui'`
}
