/**
 * Generator-side emission via ts-morph.
 *
 * Every prior generation spliced code with brittle string surgery —
 * `source.replace('pages: []', …)` — which corrupts the file the moment the
 * anchor string shifts, appears twice, or lands inside a comment. This module
 * is the fix the archive designed (aiwf `ts-morph-implementation.md`) but never
 * wired in: routes are inserted into the manifest array through the AST, so the
 * edit is structural, idempotent, and can't scramble surrounding code.
 *
 * `addRouteToManifest` is the concrete "replace one string-.replace() codegen
 * path with a ts-morph transform" deliverable. `emitResourcePage` is the
 * generator that produces a slot-bearing route module.
 */

import {
	IndentationText,
	Project,
	QuoteKind,
	SyntaxKind,
	VariableDeclarationKind,
} from 'ts-morph'

/** Everything the page generator needs. Derived upstream from a Sprout resource. */
export interface PageDescriptor {
	/**
	 * Resource id, e.g. `task` — the *type* behind the page. Drives the loader
	 * identity (`meta.resource`), the user-owned slot file, and, unless
	 * {@link PageDescriptor.module} says otherwise, the route module's file name.
	 */
	resource: string
	/**
	 * The route module's own identity, when it cannot be the resource: file stem
	 * of `routes/<module>.tsx` and the manifest entry id.
	 *
	 * A spec may declare **several pages over one entity** — a list and a board
	 * over the same records is the first thing anyone reaches for — and every one
	 * of those pages folded to the same `resource`, so every one emitted into the
	 * same `routes/<resource>.tsx`. Each run overwrote the last, `validate`
	 * reported `unsafe regen overwritten` forever, and the manifest kept only the
	 * last writer's route (issue #337).
	 *
	 * Set **only on a collision**, by `pageDescriptors` in `@maxstack/mcp`: the
	 * first page over a resource keeps the bare `routes/<resource>.tsx` it has
	 * always had, so the overwhelmingly common one-page-per-entity project sees
	 * no rename and no orphaned file. The slot file stays keyed by `resource`
	 * regardless — block slots are a property of the resource, not of the page.
	 */
	module?: string
	/** Plural human label rendered as the page heading, e.g. `Tasks`. */
	title: string
	/** The app route path, e.g. `/admin/tasks`. */
	routePath: string
	/**
	 * Named extension slots the generated page exposes. Each becomes a
	 * `<Slot name=… render={slots.<name>} />` composed from the user-owned slot
	 * file. This is the cross-file extension seam — part-generated,
	 * part-hand-written at the module boundary, no AST merge.
	 */
	slots: string[]
	/**
	 * The rows surface this page renders — present only when the emitter can
	 * actually *materialize* it as owned code (issue #349).
	 *
	 * Absent means the page's rows are not arranged as a plain list: a
	 * `calendar`/`timeline`/`board` view block arranges them ({@link view}), a
	 * `mode: 'replace'` slot owns the region ({@link listReplacedBy}), an
	 * `aggregate` block draws a chart instead of rows, or the page has no entity
	 * behind it at all. Only the last two are unmaterializable; see
	 * {@link emitResourcePage}.
	 */
	list?: PageListSurface
	/**
	 * The arranged surface this page renders instead of a list — its first
	 * `board`, `calendar` or `timeline` block, resolved (stage 2 of #349).
	 *
	 * Mutually exclusive with {@link list}, exactly as the runtime is: a view
	 * block replaces the list rather than sitting beside it.
	 *
	 * Only the *drawing* half is here. What a move writes, where the viewer is in
	 * time, and the rows themselves arrive as `OwnedRouteProps.view` at render
	 * time — a board's `options` in particular are deliberately absent, because
	 * the one thing they are used for outside the renderer is refusing a drop on
	 * an undeclared destination, and that guard stays in framework code.
	 */
	view?: PageViewSurface
	/**
	 * The `mode: 'replace'` slot that owns this page's list region, when one
	 * does — the slot's name, as `slots` carries it.
	 *
	 * A page like this has neither a list nor a view and is still fully
	 * materializable: the runtime renders its header, its control bar and its
	 * slots, and renders *nothing* where the list would have been. So the
	 * emitted module does the same, rather than claiming a surface the user
	 * already declared away.
	 */
	listReplacedBy?: string
}

/**
 * A page's arranged view, as far as the *spec* determines it — the declaration
 * inlined into an owned module as a literal instead of being re-derived from
 * `spec/` on every request.
 *
 * A discriminated union rather than one optional-everything bag: which fields
 * exist is the whole content of the decision, and a `calendar` carrying a
 * `groupField` is not a thing the spec can express.
 */
export type PageViewSurface =
	| {
			kind: 'board'
			/** The enum column whose value places a card in a column. */
			groupField: string
			/** The `rank: true` column ordering cards within a column. */
			rankField?: string
			/** The column rendered as a card's title. */
			titleField?: string
			/** Extra columns rendered on the card under its title. */
			cardFields?: string[]
	  }
	| {
			kind: 'calendar'
			/** The date column each row is placed by. */
			dateField: string
			/** An optional second date column ending a multi-day entry. */
			endField?: string
			/** The column rendered as an entry's label. */
			titleField?: string
			/** How the grid is drawn. */
			display: 'month' | 'week' | 'heatmap'
			/** IANA zone the days are bucketed in. */
			timezone: string
	  }
	| {
			kind: 'timeline'
			/** The date column a bar starts at. */
			startField: string
			/** The date column a bar ends at. */
			endField: string
			/** The column rendered as a bar's label. */
			titleField?: string
			/** A self-referencing column drawn as a dependency arrow. */
			dependsOn?: string
			/** IANA zone the days are bucketed in. */
			timezone: string
	  }

/**
 * A page's list surface, as far as the *spec* determines it — the part that can
 * be inlined into an owned module as a literal instead of being re-derived from
 * `spec/` on every request.
 *
 * Deliberately only the spec-derived half. The introspected columns, the
 * primary key, the rows and the viewer's capabilities are facts about the
 * database and the session, not about the page, and they keep arriving as
 * props (`OwnedRouteProps.list`).
 */
export interface PageListSurface {
	/**
	 * Which list component renders the rows — the first `table` block's
	 * `variant`. This is the decision an ejected module genuinely takes over:
	 * the framework picks it from the spec at request time, the emitted module
	 * picks it by importing one component and not the others.
	 */
	variant: 'table' | 'cards' | 'feed'
	/**
	 * The declared field subset, in order — the first `table` block's `fields`.
	 * Only the card and feed variants read it (as their primary/secondary
	 * fields); the table's columns come from introspection.
	 */
	fields?: string[]
}

const BANNER = [
	'// AUTO-GENERATED by maxstack — DO NOT EDIT.',
	'// Owned by the framework; regeneration overwrites this file. To take',
	'// ownership run `maxstack eject <id>`. Customize without ejecting by',
	'// filling the user-owned slot file this page composes from.',
].join('\n')

/** The block-`type` prefix marking a page block as a named extension slot. */
const SLOT_TYPE_PREFIX = 'slot:'

/**
 * Whether a block's `type` marks it as a named extension slot (`slot:<name>`).
 * Only these blocks get a `<Slot>` in the generated route and a render-fn stub
 * in the user-owned slot file — other template blocks (`table`, `form`, …)
 * have no runtime slot seam.
 */
export function isSlotBlockType(type: string): boolean {
	return type.startsWith(SLOT_TYPE_PREFIX)
}

/**
 * The ONE canonical slot name, shared by route generation (`pageDescriptor`)
 * and the live runtime (`project-routes.ts`'s `getRoutes`): the `<name>` suffix
 * of a `slot:<name>` block type. Before issue #42 the generator instead named
 * slots from the block `id`, so a filled slot only worked when a block's id
 * happened to stem-match its own type suffix.
 */
export function slotBlockName(type: string): string {
	return type.slice(SLOT_TYPE_PREFIX.length)
}

/**
 * The slot name a block's `id` alone would have implied under the pre-#42
 * derivation (`blk-pack-loadout` → `pack_loadout`). No longer used to name
 * anything — kept only so `validate` can flag a `slot:` block whose id reads
 * as a different slot than its type declares, which is almost always a
 * copy-paste mistake worth surfacing even though it no longer breaks the app.
 */
export function slotIdHint(blockId: string): string {
	const stem = blockId.replace(/^blk-/, '').replace(/[^a-zA-Z0-9]/g, '_')
	return /^[a-zA-Z_]/.test(stem) ? stem : `s_${stem}`
}

/**
 * The route module's file stem and manifest id — `module` when the page had to
 * be disambiguated from a sibling over the same entity, the resource otherwise.
 * The ONE place that fold happens, so the emitter, the writer, the manifest and
 * the drift report cannot disagree about which file a page owns.
 */
export function pageModuleKey(descriptor: PageDescriptor): string {
	return descriptor.module ?? descriptor.resource
}

/** `task` → `TaskListPage`. */
function pageComponentName(resource: string): string {
	const pascal = resource
		.split(/[_\-\s]+/)
		.filter(Boolean)
		.map((w) => w.charAt(0).toUpperCase() + w.slice(1))
		.join('')
	return `${pascal}ListPage`
}

/** Repo-relative-ish module specifier the page imports its slot file by. */
export function slotModuleSpecifier(resource: string): string {
	return `./${resource}.slots.tsx`
}

function newProject(): Project {
	return new Project({
		useInMemoryFileSystem: true,
		manipulationSettings: {
			indentationText: IndentationText.Tab,
			quoteKind: QuoteKind.Single,
		},
	})
}

/**
 * The `@maxstack/ui` list component each declared variant renders through.
 *
 * Exported because `maxstack add view` emits an owned module for the same
 * surface and must pick the same component: a second copy of this map is how
 * `add view` came to emit a `ResourceList` onto a page the spec declares as
 * `cards`, silently downgrading it (issue #360).
 */
export const VARIANT_COMPONENT = {
	table: 'ResourceList',
	cards: 'CardGrid',
	feed: 'FeedList',
} as const

/**
 * The `@maxstack/ui` component each arranged view renders through — the view
 * half of {@link VARIANT_COMPONENT}, and the same rule: the emitter picks one
 * component and imports only that one, so an unused import can never reach a
 * DO-NOT-EDIT file.
 */
export const VIEW_COMPONENT = {
	board: 'BoardView',
	calendar: 'CalendarView',
	timeline: 'TimelineView',
} as const

/**
 * The "+ New" affordance, matching the framework list's own header.
 *
 * Exported because `maxstack add view` emits the same header from the same
 * `OwnedRouteProps` (issue #356). Two owned-page emitters that agree about the
 * contract and disagree about the button are still two shapes.
 */
export const NEW_LINK_CLASS =
	'inline-flex h-9 items-center rounded-md bg-primary px-4 text-sm font-medium text-primary-foreground no-underline shadow transition-colors hover:bg-primary/90'

/**
 * Why a page's list surface could not be materialized, said in the file.
 *
 * An ejected module replaces the page's whole surface, so a page this generator
 * could not write is a page that renders a heading and nothing else once
 * ejected. That is a trap worth spending four lines on: before #349 the file
 * said nothing at all and the user discovered it by looking at a blank page.
 */
/**
 * The marker {@link isMaterializedPage} reads. One definition, because the CLI
 * warns off an eject by looking for it in the file it is about to hand over.
 */
export const UNMATERIALIZED_MARKER = 'NOT MATERIALIZED'

/**
 * Whether an emitted route module actually renders its page.
 *
 * A source-text check rather than a spec re-derivation on purpose: `maxstack
 * eject` is handing over *this file*, so what matters is what is in it — which
 * stays true for a module generated by an older version, and for one the user
 * has since edited into a real page.
 */
export function isMaterializedPage(source: string): boolean {
	return !source.includes(UNMATERIALIZED_MARKER)
}

const UNMATERIALIZED_NOTE = [
	`\t\t\t{/* ${UNMATERIALIZED_MARKER}. This page draws an aggregate (a chart over a`,
	'\t\t    GROUP BY the server computes) or has no entity behind it, and the',
	'\t\t    generator cannot yet emit that surface as owned code — so this is a',
	'\t\t    placeholder, not the page. While the route is generated the runtime',
	'\t\t    still renders the real surface; ejecting it replaces that surface',
	'\t\t    with this stub. Prefer a block slot until it materializes. List,',
	'\t\t    board, calendar and timeline pages DO materialize — this is not one. */}',
].join('\n')

/**
 * Emit the route module for a resource.
 *
 * For an ordinary list page this is the **materialized** page: the header, the
 * declared list variant rendered from the props the runtime hands down
 * (`OwnedRouteProps`), and one `<Slot>` per declared slot. That is what makes
 * `maxstack eject` a real handover — before #349 the body was a comment, so the
 * file a user "took ownership of" had never rendered their page.
 *
 * A page arranged by a `board`, `calendar` or `timeline` block materializes the
 * same way (stage 2 of #349): the declaration is inlined as literal attributes
 * and the declared view component is rendered from `OwnedRouteProps.view`. So
 * is a page whose list a `mode: 'replace'` slot owns — the runtime renders
 * nothing in that region, and so does this.
 *
 * What is left is a page the generator genuinely cannot write: an `aggregate`
 * block (a chart over a GROUP BY that never reaches the rows contract) and a
 * page with no entity behind it. Those keep the placeholder body, with
 * {@link UNMATERIALIZED_NOTE} saying so out loud.
 *
 * Deterministic — the same descriptor always yields byte-identical output,
 * which is what makes regeneration-as-diff meaningful.
 */
export function emitResourcePage(descriptor: PageDescriptor): string {
	const { resource, title, slots, list, view, listReplacedBy } = descriptor
	// The three materialized shapes, and the one that is not. Read once, because
	// the parameter list, the imports, the header and the body each have to make
	// the same call and a disagreement between any two of them is either an
	// unused binding or an undefined one.
	const materialized = Boolean(list || view || listReplacedBy)
	// The component is named for the *module* — two pages over one entity are two
	// modules, and naming both `BookListPage` would make a stack trace or an
	// import in owned code ambiguous about which route it came from. `meta` and
	// `data-resource` below stay the resource: those are the loader's identity,
	// which both pages genuinely share.
	const key = pageModuleKey(descriptor)
	const component = pageComponentName(key)
	const project = newProject()
	const sf = project.createSourceFile(`${key}.tsx`)

	// Every `@maxstack/ui` binding the body below actually renders, and nothing
	// else. Dead imports are not cosmetic here: this file is stamped
	// DO-NOT-EDIT, so an unused import fails the *user's* own lint gate
	// (`noUnusedImports` is on by default in Biome) on framework-owned code they
	// cannot fix without ejecting. Sorted case-insensitively, which is the order
	// Biome's import organizer wants, so a scaffold is clean on first run.
	const uiImports = new Set<string>()
	if (list) uiImports.add(VARIANT_COMPONENT[list.variant])
	if (view) uiImports.add(VIEW_COMPONENT[view.kind])
	if (materialized) uiImports.add('type OwnedRouteProps')
	if (slots.length > 0) uiImports.add('Slot')
	if (uiImports.size > 0) {
		sf.addImportDeclaration({
			moduleSpecifier: '@maxstack/ui',
			namedImports: [...uiImports].sort((a, b) =>
				a.replace('type ', '').localeCompare(b.replace('type ', '')),
			),
		})
	}
	if (slots.length > 0) {
		sf.addImportDeclaration({
			moduleSpecifier: slotModuleSpecifier(resource),
			namespaceImport: 'slots',
		})
	}

	sf.addVariableStatement({
		isExported: true,
		declarationKind: VariableDeclarationKind.Const,
		declarations: [
			{
				name: 'meta',
				initializer: `{ resource: '${resource}', generated: true }`,
			},
		],
	})

	// The declared field subset, inlined as a literal. This is the point of
	// materializing: the card/feed variants read it here, in a file the user
	// owns, instead of the runtime re-deriving it from `spec/` every request.
	if (list?.fields && list.fields.length > 0 && list.variant !== 'table') {
		sf.addVariableStatement({
			declarationKind: VariableDeclarationKind.Const,
			declarations: [
				{
					name: 'LIST_FIELDS',
					initializer: `[${list.fields.map((f) => `'${f}'`).join(', ')}]`,
				},
			],
		})
	}

	// A board's card fields, inlined for the same reason the list's are: it is a
	// spec-derived drawing decision, and this is the file that now owns it.
	if (view?.kind === 'board' && view.cardFields && view.cardFields.length > 0) {
		sf.addVariableStatement({
			declarationKind: VariableDeclarationKind.Const,
			declarations: [
				{
					name: 'CARD_FIELDS',
					initializer: `[${view.cardFields.map((f) => `'${f}'`).join(', ')}]`,
				},
			],
		})
	}

	const slotJsx = slots
		.map((name) => `\t\t\t<Slot name="${name}" render={slots.${name}} />`)
		.join('\n')

	// The note lives in the JSX, not the file header: `eject()` strips the
	// leading comment block when it swaps in its own banner, so a header comment
	// would vanish at exactly the moment the user most needs to read it.
	//
	// A `mode: 'replace'` page contributes nothing here on purpose: the runtime
	// renders *nothing* where the list would be, and the slot that owns the
	// region is already mounted below with the page's other slots. Emitting a
	// list here would contradict a declaration the user has already made.
	const surfaceJsx = list
		? listSurfaceJsx(list)
		: view
			? viewSurfaceJsx(view)
			: listReplacedBy
				? ''
				: UNMATERIALIZED_NOTE
	const header = materialized
		? [
				'\t\t\t<header className="mb-4 flex items-center justify-between">',
				`\t\t\t\t<h1 className="text-2xl font-semibold">${title}</h1>`,
				'\t\t\t\t<Link',
				'\t\t\t\t\tto={newHref}',
				`\t\t\t\t\tclassName="${NEW_LINK_CLASS}"`,
				'\t\t\t\t>',
				'\t\t\t\t\t+ New',
				'\t\t\t\t</Link>',
				'\t\t\t</header>',
			].join('\n')
		: `\t\t\t<h1>${title}</h1>`

	// The control bar, rendered above the list exactly where the framework's own
	// page puts it (#342). One identifier, because the wiring — filter state in
	// the query string, read back by the loader, search upgrading to the ranked
	// index — is the part an owned page must not have to reimplement. Move the
	// line and the bar moves; delete it and the page loses search, facets and
	// export, which is a choice the owner is now able to make rather than one
	// the eject made for them.
	//
	// A view page gets none, matching the runtime: a calendar's rows are a window
	// on a date column and a board's are ordered by a rank key, so the loader
	// reads no filters there and a bar that changed nothing would be a lie. What
	// a view page gets instead is `{view.paging}`, emitted with the surface.
	const toolbarJsx = list || listReplacedBy ? '\t\t\t{toolbar}' : ''
	// The one line of control flow in an emitted page. `view` is optional on the
	// contract because most pages are lists, and TypeScript is right to insist:
	// the framework passes it for exactly the pages it arranges, which is the
	// page this module was generated for.
	const guard = view
		? [
				'// The framework hands `view` to the pages it arranges — this is one.',
				'if (!view) return null',
				'',
			].join('\n')
		: ''
	const body = [
		guard,
		'return (',
		`\t\t<section data-resource="${resource}">`,
		header,
		toolbarJsx,
		surfaceJsx,
		slotJsx,
		'\t\t</section>',
		'\t)',
	]
		.filter(Boolean)
		.join('\n')

	// Exactly the bindings the body above mentions. An unused one fails the
	// scaffold's own lint (`noUnusedFunctionParameters`) on a DO-NOT-EDIT file,
	// and a missing one does not compile — so this list is derived from the same
	// three flags the body was, never restated.
	const params = [
		...(list ? ['list'] : []),
		...(view ? ['view'] : []),
		'newHref',
		...(list || listReplacedBy ? ['toolbar'] : []),
		'Link',
	]
	const fn = sf.addFunction({
		name: component,
		isExported: true,
		isDefaultExport: true,
		// A placeholder page takes no props: it renders nothing that needs them,
		// and an unused binding would fail the scaffold's lint. Omitting the
		// parameter keeps it assignable to `ComponentType<OwnedRouteProps>` all
		// the same, so `OWNED_ROUTES` stays uniformly typed.
		parameters: materialized
			? [{ name: `{ ${params.join(', ')} }`, type: 'OwnedRouteProps' }]
			: [],
	})
	fn.setBodyText(body)

	// Normalize to Biome-ish style: tabs, no semicolons.
	sf.formatText({ indentSize: 1, convertTabsToSpaces: false })
	let printed = sf.getFullText().replace(/;\n/g, '\n').replace(/;$/gm, '')
	// ts-morph's printer never wraps a parameter list, so a signature past
	// Biome's 80 columns would hand the user a DO-NOT-EDIT file their own `lint
	// --write` immediately reformats — a scaffold whose first diff is noise, in a
	// file they cannot edit without ejecting. Measured rather than assumed: the
	// list page's four bindings never fit, a view page's three sometimes do, and
	// wrapping one that fits is the same defect in the other direction.
	if (materialized) {
		const oneLine = `${params.length > 0 ? `{ ${params.join(', ')} }` : ''}: OwnedRouteProps`
		const signature = `export default function ${component}(${oneLine}) {`
		if (signature.length > BIOME_LINE_WIDTH) {
			printed = printed.replace(
				`(${oneLine})`,
				`({\n${params.map((p) => `\t${p},\n`).join('')}}: OwnedRouteProps)`,
			)
		}
	}
	return `${BANNER}\n${printed.startsWith('\n') ? printed.slice(1) : printed}`
}

/** Biome's `formatter.lineWidth` for this repo, and for a scaffolded project. */
const BIOME_LINE_WIDTH = 80

/** Biome's `formatter.indentWidth` — how many columns one emitted tab counts as. */
const BIOME_INDENT_WIDTH = 2

/**
 * The list surface itself: the declared variant, spread with exactly the props
 * the framework's own list would have rendered with.
 *
 * `{...list}` rather than twenty named props on purpose — it is the one line
 * that keeps a materialized page working when the runtime learns to pass
 * something new, and it is the line a user edits to override one thing
 * (`<ResourceList {...list} selectable />`) without re-deriving the rest.
 */
function listSurfaceJsx(list: PageListSurface): string {
	const component = VARIANT_COMPONENT[list.variant]
	// Only the card and feed variants take fields: a table's columns come from
	// database introspection, which no literal in this file could stand in for.
	const fielded =
		list.variant !== 'table' && list.fields && list.fields.length > 0
	if (!fielded) return jsxElement(component, ['{...list}'])
	return jsxElement(component, [
		'{...list}',
		'primaryField={LIST_FIELDS[0]}',
		'secondaryFields={LIST_FIELDS}',
	])
}

/**
 * The arranged surface: the declared view component, spread with the props the
 * framework's own `ArrangedView` would have rendered it with, and the spec's
 * declaration inlined as literal attributes over the top.
 *
 * That split is the whole design. `{...view}` carries what only the route can
 * produce — rows, introspection, the paging links, the write handler — so a
 * materialized board keeps working when the runtime learns to pass something
 * new. The attributes carry what the *spec* said, so the decision an ejected
 * page genuinely takes over stops being re-read from `spec/` on every request
 * and becomes a line the owner can edit.
 *
 * The board's `options` are deliberately NOT inlined. They look like a drawing
 * input and are not one: `<BoardView>` derives its columns from the grouping
 * column's introspected `meta.options`, which arrives in `{...view}`, and the
 * only other reader is the guard that refuses a drop on a destination the enum
 * does not declare. Inlining them would move a write-side check into a file the
 * user is invited to edit while changing nothing about what is drawn.
 */
function viewSurfaceJsx(view: PageViewSurface): string {
	const component = VIEW_COMPONENT[view.kind]
	const attrs: string[] = ['{...view}']
	if (view.kind === 'board') {
		attrs.push(attr('groupField', view.groupField))
		if (view.rankField) attrs.push(attr('rankField', view.rankField))
		if (view.titleField) attrs.push(attr('titleField', view.titleField))
		if (view.cardFields && view.cardFields.length > 0)
			attrs.push('cardFields={CARD_FIELDS}')
	} else if (view.kind === 'calendar') {
		attrs.push(attr('dateField', view.dateField))
		if (view.endField) attrs.push(attr('endField', view.endField))
		if (view.titleField) attrs.push(attr('titleField', view.titleField))
		attrs.push(attr('display', view.display), attr('timezone', view.timezone))
	} else {
		attrs.push(attr('startField', view.startField))
		attrs.push(attr('endField', view.endField))
		if (view.titleField) attrs.push(attr('titleField', view.titleField))
		if (view.dependsOn) attrs.push(attr('dependsOnField', view.dependsOn))
		attrs.push(attr('timezone', view.timezone))
	}
	return [
		// A board has no time axis, so it has no period navigation — the runtime
		// renders none either, and `view.paging` is empty there. Emitting the line
		// anyway would put an empty node in a file whose author would reasonably
		// wonder what it was for.
		...(view.kind === 'board' ? [] : ['\t\t\t{view.paging}']),
		jsxElement(component, attrs),
		// A truncated window looks exactly like a complete one, which is why this
		// is on every arranged surface rather than the date ones alone.
		'\t\t\t{view.notice}',
	].join('\n')
}

/** One JSX string attribute, with the quoting Biome wants for JSX. */
function attr(name: string, value: string): string {
	return `${name}="${value.replace(/"/g, '&quot;')}"`
}

/**
 * A self-closing JSX element at the page body's indent, printed the way Biome
 * would print it: one line when it fits, one attribute per line when it does
 * not.
 *
 * Measured, not assumed. `<BoardView {...view} groupField="status" />` fits and
 * `<CalendarView …>` with a timezone does not, so an emitter that always split
 * (or never did) would hand the user a DO-NOT-EDIT file their own `lint
 * --write` reformats on first run — in a file they cannot edit without
 * ejecting, which is the whole reason stage 1 measured the signature too.
 */
function jsxElement(component: string, attrs: readonly string[]): string {
	const indent = '\t\t\t'
	const oneLine = `${indent}<${component} ${attrs.join(' ')} />`
	// A tab is `formatter.indentWidth` columns wide to Biome, not one.
	const width = oneLine.length + indent.length * (BIOME_INDENT_WIDTH - 1)
	if (width <= BIOME_LINE_WIDTH) return oneLine
	return [
		`${indent}<${component}`,
		...attrs.map((a) => `${indent}\t${a}`),
		`${indent}/>`,
	].join('\n')
}

/**
 * Emit the ONE-TIME user-owned slot stub. Written only when the file is absent
 * (never-clobber): once the user edits it, the generator must never touch it
 * again. Each declared slot gets an exported render function returning null so
 * the page typechecks and renders before the user fills anything in.
 */
export function emitUserSlotStub(descriptor: PageDescriptor): string {
	const { slots } = descriptor
	const fns = slots
		.map((name) =>
			[
				`// Fill in your ${name} content. This file is yours — the`,
				'// generator created it once and will never overwrite it.',
				`export function ${name}() {`,
				// Deliberately not `null`. An exported stub is already registered in
				// OWNED_SLOTS, so a `mode: "replace"` slot suppresses the default list
				// the moment it is scaffolded — and a stub returning null then left
				// the page completely blank, with nothing to say why. A visible
				// placeholder keeps the page self-explanatory between scaffolding and
				// implementation, and it disappears the moment real content lands.
				`\treturn <p>Slot \`${name}\` — implement this in this file.</p>`,
				'}',
			].join('\n'),
		)
		.join('\n\n')
	return `${fns}\n`
}

/**
 * The names a slot file already exports, via the AST (so a user who renamed,
 * reformatted, or wrapped a stub is still recognized). Covers `export function
 * f() {}` and `export const f = …` — the two shapes a slot render fn takes.
 */
export function exportedSlotNames(source: string): string[] {
	const project = newProject()
	const sf = project.createSourceFile('slots.tsx', source)
	const names = new Set<string>()
	for (const fn of sf.getFunctions()) {
		if (fn.isExported()) {
			const name = fn.getName()
			if (name) names.add(name)
		}
	}
	for (const stmt of sf.getVariableStatements()) {
		if (!stmt.isExported()) continue
		for (const decl of stmt.getDeclarations()) names.add(decl.getName())
	}
	return [...names]
}

/**
 * Given the current slot-file content, emit the render-fn stubs for any declared
 * slots that aren't exported yet — the append-only "scaffold a newly-added slot"
 * payload. Returns the stub text (empty when nothing is missing) and the slot
 * names it covers, so the writer can append without touching existing content.
 * This closes the task-9 gap where a slot added to a live page left its
 * `render={slots.X}` reference dangling.
 */
export function emitMissingSlotStubs(
	source: string,
	descriptor: PageDescriptor,
): { stubs: string; added: string[] } {
	const have = new Set(exportedSlotNames(source))
	const added = descriptor.slots.filter((name) => !have.has(name))
	if (added.length === 0) return { stubs: '', added }
	return { stubs: emitUserSlotStub({ ...descriptor, slots: added }), added }
}

export interface RouteEntryLiteral {
	path: string
	file: string
}

/** The `path:` of a route array element, for canonical ordering. */
function elementPath(text: string): string {
	return /path:\s*'([^']*)'/.exec(text)?.[1] ?? text
}

/**
 * AST-insert a route into a `routes.ts` manifest — the ts-morph transform that
 * replaces `source.replace('pages: []', …)`. Finds `export const routes = [`,
 * inserts `{ path, file }` if a route with that `path` isn't already present
 * (idempotent), and returns the reprinted source. Because it operates on the
 * array node, it is immune to the anchor-string fragility that broke every
 * generation's string splice.
 *
 * The array is kept sorted **by route path** rather than in insertion order
 *. These are distinct static paths, so matching does not depend on
 * their sequence — but generation order does, and generation order is install
 * order. Appending would mean two developers who added the same bundles in a
 * different sequence get different `routes.ts` bytes, and every diff between
 * them is noise. Canonical order makes the file a function of *what* is
 * installed rather than of *when* each part was.
 *
 * The seed manifest ({@link EMPTY_ROUTES_MANIFEST}) is what a fresh project
 * starts from.
 */
export function addRouteToManifest(
	source: string,
	entry: RouteEntryLiteral,
): string {
	const project = new Project({
		useInMemoryFileSystem: true,
		manipulationSettings: {
			indentationText: IndentationText.Tab,
			quoteKind: QuoteKind.Single,
		},
	})
	const sf = project.createSourceFile('routes.ts', source)

	const decl = sf.getVariableDeclarationOrThrow('routes')
	const array = decl.getInitializerIfKindOrThrow(
		SyntaxKind.ArrayLiteralExpression,
	)

	const existing = array.getElements().map((el) => el.getText())
	const already = existing.some((text) =>
		text.includes(`path: '${entry.path}'`),
	)
	const next = already
		? existing
		: [...existing, `{ path: '${entry.path}', file: '${entry.file}' }`]
	const sorted = [...next].sort((a, b) =>
		elementPath(a).localeCompare(elementPath(b)),
	)
	// Rewrite only when something actually moved — an untouched manifest must
	// come back byte-identical, since `generateResourcePage` writes on inequality.
	if (already && sorted.every((text, i) => text === existing[i])) return source
	array.replaceWithText(`[${sorted.join(', ')}]`)

	sf.formatText({ indentSize: 1, convertTabsToSpaces: false })
	return sf.getFullText().replace(/;\n/g, '\n').replace(/;$/gm, '')
}

/**
 * AST-remove every route in a `routes.ts` manifest that points at `file` — the
 * inverse of {@link addRouteToManifest}, and the half that was missing until
 * issue #338: generation only ever appended, so a page deleted from the spec
 * left its route wired to a module whose resource no longer exists, and the app
 * shipped a 500 nobody had a way to remove short of editing the file by hand.
 *
 * Matched on the **module**, not on the route path. A path can legitimately move
 * to a different module in the same run — delete the first of two pages over an
 * entity and the survivor inherits the bare `routes/<resource>.tsx`, while the
 * path it serves has not changed — and removing by path would then delete the
 * line the very next generation step is about to need. The module is the thing
 * being retired, so the module is the key.
 *
 * Returns the source unchanged (byte-identical, not reprinted) when no route
 * pointed there, so a caller can write on inequality.
 */
export function removeRoutesToModule(source: string, file: string): string {
	const project = newProject()
	const sf = project.createSourceFile('routes.ts', source)
	const decl = sf.getVariableDeclarationOrThrow('routes')
	const array = decl.getInitializerIfKindOrThrow(
		SyntaxKind.ArrayLiteralExpression,
	)
	const existing = array.getElements().map((el) => el.getText())
	const kept = existing.filter((text) => !text.includes(`file: '${file}'`))
	if (kept.length === existing.length) return source
	array.replaceWithText(`[${kept.join(', ')}]`)
	sf.formatText({ indentSize: 1, convertTabsToSpaces: false })
	return sf.getFullText().replace(/;\n/g, '\n').replace(/;$/gm, '')
}

export const EMPTY_ROUTES_MANIFEST = `export const routes = []\n`
