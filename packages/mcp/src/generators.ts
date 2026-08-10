/**
 * The generator registry + the built-in generators the platform ships with.
 *
 * A generator is a function of the `SpecSystem` → artifacts (`{ path, content }`).
 * The MCP `run_generator` tool exposes them by name; the in-memory runner returns
 * the artifacts as data (so tests can assert on them and an agent can review a
 * diff), while a disk-backed host wraps the same generators to land the files.
 *
 * The three built-ins:
 *   - `page`      — the **real Phase 2 code generator**: drives
 *                   `generateResourcePage` (ts-morph emission + never-clobber +
 *                   cross-file slots + `routes.ts` AST insertion) from the spec's
 *                   pages, so `run_generator` emits actual app code, not stubs;
 *   - `docs`      — **project-tailored docs** (Phase 3 scope): a Markdown
 *                   overview derived from the live spec, so it can't drift from it;
 *   - `e2e-tests` — Playwright test stubs, one `test()` per `page.e2eTests`
 *                   string (the mxscratchpad convention, §3-L4B).
 */

import {
	introspectTable,
	type SproutColumn,
	type SproutResource,
	tableFromSpecEntity,
} from '@maxstack/core'
import {
	createMemFs,
	generateResourcePage,
	isSlotBlockType,
	type PageDescriptor,
	type PageListSurface,
	type PageViewSurface,
	pageModuleKeys,
	pageModuleResource,
	slotBlockName,
} from '@maxstack/core/ownership'
import {
	type EntitySpec,
	type PageSpec,
	type SpecSystem,
	unauthoredPrdNotice,
	unauthoredPrdSections,
	VIEW_BLOCK_TYPES,
} from '@maxstack/spec'
import type {
	GeneratorInfo,
	GeneratorResult,
	GeneratorRunner,
	RegisteredGenerator,
} from './context.ts'
import { PlatformToolError } from './errors.ts'
import { groundedEntityShapes } from './grounding.ts'

/** Build a runner over a fixed set of generators. */
export function createGeneratorRegistry(
	generators: RegisteredGenerator[],
): GeneratorRunner {
	const byName = new Map(generators.map((g) => [g.name, g]))
	return {
		list(): GeneratorInfo[] {
			return generators.map(({ name, summary }) => ({ name, summary }))
		},
		async run(name, spec, args): Promise<GeneratorResult> {
			const gen = byName.get(name)
			if (!gen)
				// Addressed to the caller — it names what they asked for and what they
				// could have asked for instead, so it survives the #353 boundary.
				throw new PlatformToolError(
					`Unknown generator "${name}". Available: ${[...byName.keys()].join(', ') || '(none)'}`,
				)
			return gen.run(spec, args)
		},
	}
}

/**
 * A count and its noun, agreeing in number: `1 entity`, `2 entities`.
 *
 * Every generator here prints counted nouns, and a one-of-anything spec is the
 * state every project is in right after `maxstack init` plus one op — so "1
 * entities" in the generated docs is the first thing most people read. The
 * `thing(s)` dodge is the same bug wearing a hat. One helper, used at every
 * site, so a new heading can't reintroduce it.
 */
export function counted(
	n: number,
	singular: string,
	plural = `${singular}s`,
): string {
	return `${n} ${n === 1 ? singular : plural}`
}

// ===========================================================================
// docs — project-tailored Markdown, derived from the spec
// ===========================================================================

/**
 * The generated overview used to open with whatever `maxstack init` had written
 * — a placeholder tl;dr, a placeholder problem statement, and a requirement
 * whose acceptance criteria were "I can create, read, update, and delete the
 * core records" (#343). That is the first document a human opens, and it led
 * with three paragraphs nobody wrote, ahead of the pages and entities that were
 * real.
 *
 * So an unauthored section is **omitted** here rather than printed, and the
 * omission is stated at the top. A doc derived from the spec cannot invent the
 * missing half, but it can refuse to pass scaffold off as content.
 */
function docsOverview(spec: SpecSystem): string {
	const { product, data, pages, pricing } = spec
	const unwritten = new Set(unauthoredPrdSections(product).map((s) => s.path))
	const lines: string[] = []
	lines.push(`# ${product.meta.title}`, '')
	if (product.context.tldr && !unwritten.has('context.tldr'))
		lines.push(product.context.tldr, '')

	const notice = unauthoredPrdNotice(product)
	if (notice)
		lines.push(`> **${notice}** Sections below it would fill are omitted.`, '')

	if (!unwritten.has('problem.statement'))
		lines.push('## Problem', '', product.problem.statement, '')

	if (!unwritten.has('goals.northStarMetric')) {
		lines.push('## North-star metric', '')
		const ns = product.goals.northStarMetric
		lines.push(`- **${ns.name}** — ${ns.definition}`, '')
	}

	if (!unwritten.has('requirements')) {
		lines.push(`## Requirements (${product.requirements.length})`, '')
		for (const r of product.requirements) {
			lines.push(`### ${r.id} · ${r.priority}`, '', r.userStory, '')
			if (r.acceptanceCriteria.length) {
				lines.push('Acceptance criteria:')
				for (const c of r.acceptanceCriteria) lines.push(`- ${c}`)
				lines.push('')
			}
		}
	}

	lines.push(
		`## Data model (${counted(data.entities.length, 'entity', 'entities')})`,
		'',
	)
	for (const e of data.entities) {
		const fields = e.fields
			.map((f) => `${f.name}: ${f.type}${f.required ? '' : '?'}`)
			.join(', ')
		lines.push(`- **${e.name}** (${e.id})${fields ? ` — ${fields}` : ''}`)
	}
	lines.push('')

	lines.push(`## Pages (${pages.pages.length})`, '')
	for (const p of pages.pages) {
		lines.push(
			`- **${p.name}** \`${p.route}\` (${counted(p.blocks.length, 'block')})`,
		)
	}
	lines.push('')

	if (pricing.tiers.length) {
		lines.push(`## Pricing`, '')
		for (const t of pricing.tiers)
			lines.push(`- **${t.name}** — $${t.priceMonthly}/mo`)
		lines.push('')
	}

	lines.push('---', '', '_Generated from the spec by `run_generator docs`._')
	return lines.join('\n')
}

export const docsGenerator: RegisteredGenerator = {
	name: 'docs',
	summary: 'Project-tailored Markdown docs derived from the live spec.',
	run(spec): GeneratorResult {
		return {
			generator: 'docs',
			artifacts: [{ path: 'docs/OVERVIEW.md', content: docsOverview(spec) }],
			notes: [
				`Generated docs/OVERVIEW.md from ${counted(spec.product.requirements.length, 'requirement')}.`,
				// Named in the notes, not only inside the artifact: an agent reads
				// the notes and may never open the file it just wrote.
				...(unauthoredPrdNotice(spec.product)
					? [
							`${unauthoredPrdNotice(spec.product)} Those sections are omitted from the overview rather than printed as content.`,
						]
					: []),
			],
		}
	},
}

// ===========================================================================
// e2e-tests — one Playwright test() per page.e2eTests string
// ===========================================================================

/**
 * The stub body: navigate, then **assert the navigation worked**.
 *
 * The assertion is not decoration and it is not a placeholder (#341). The
 * previous stub was `goto` and a comment, and `goto` does not throw on a 4xx or
 * a 5xx — so the moment `e2e` became a declared script, every unfilled stub was
 * a test that passed without checking anything, and a page whose route was not
 * served at all reported green. That is the exit-0 stub this issue names as
 * worse than no script: it converts an honest UNEXAMINED into a false green.
 *
 * `response.ok()` is the weakest claim that is still a claim, and it is exactly
 * the one that fails when a spec change stops serving the route the test was
 * transcribed for. The TODO stays: filling in the real behaviour is still the
 * work, and `maxstack gen` never overwrites a spec file that already exists.
 *
 * It also keeps `expect` imported, which the scaffolded `lint` script now cares
 * about — but the assertion is here because a stub that cannot fail is not a
 * test, not to satisfy a linter.
 */
function e2eSpecFor(pageName: string, route: string, tests: string[]): string {
	const body = tests
		.map(
			(t) =>
				`\ttest(${JSON.stringify(t)}, async ({ page }) => {\n` +
				`\t\tconst response = await page.goto(${JSON.stringify(route)})\n` +
				'\t\texpect(response?.ok(), ' +
				`${JSON.stringify(`${route} must load before this test can check anything`)}).toBe(true)\n` +
				`\t\t// TODO(agent): implement — ${t}\n` +
				`\t})`,
		)
		.join('\n\n')
	return (
		`import { expect, test } from '@playwright/test'\n\n` +
		`// Generated stubs for "${pageName}" (${route}). Fill each body in.\n` +
		`test.describe(${JSON.stringify(pageName)}, () => {\n${body}\n})\n`
	)
}

function slug(route: string): string {
	return route.replace(/^\//, '').replace(/[^a-z0-9]+/gi, '-') || 'index'
}

export const e2eTestsGenerator: RegisteredGenerator = {
	name: 'e2e-tests',
	summary:
		'Playwright test stubs, one test() per page.e2eTests string (agent fills bodies).',
	run(spec): GeneratorResult {
		const artifacts = spec.pages.pages
			.filter((p) => (p.e2eTests?.length ?? 0) > 0)
			.map((p) => ({
				path: `e2e/${slug(p.route)}.spec.ts`,
				content: e2eSpecFor(p.name, p.route, p.e2eTests ?? []),
			}))
		return {
			generator: 'e2e-tests',
			artifacts,
			notes: artifacts.length
				? [`Scaffolded ${counted(artifacts.length, 'e2e spec file')}.`]
				: ['No pages declare e2eTests — nothing to scaffold.'],
		}
	},
}

// ===========================================================================
// page — the real ts-morph code generator (ownership/), driven through MCP
// ===========================================================================

/**
 * Map a spec page to the code generator's descriptor — the ONE fold from the
 * page layer into `generateResourcePage` input. Exported so a disk-backed host
 * (the demo script, later the CLI) lands the same code this generator previews.
 *
 * Only `slot:<name>` blocks become declared slots, named from their type
 * suffix via `slotBlockName` — the same derivation the live runtime uses
 * (`project-routes.ts`'s `getRoutes`) — so a generated route's `<Slot>` and its
 * scaffolded render-fn stub always agree with what `OWNED_SLOTS` is keyed by
 * at request time. Other block types (`table`, `form`, …) have no
 * runtime slot seam and no longer get dead-code stubs scaffolded for them.
 *
 * Says nothing about which **file** the page emits into: one page in isolation
 * cannot know whether a sibling claims the same resource. Anything that writes
 * or derives a route module must go through {@link pageDescriptors}, which sees
 * the whole page list. This stays the fold for callers that only want the
 * page's *resource* (the review surfaces group rows by it).
 */
export function pageDescriptor(
	page: PageSpec,
	/**
	 * The spec's entities, when the caller has them.
	 *
	 * Needed for exactly one decision, and it is a decision the runtime makes the
	 * same way: a `board` block's columns are its grouping field's *declared*
	 * options, and a board whose grouping field has none is skipped — the runtime
	 * renders that page as a plain list. Without the entities the generator
	 * cannot tell those apart, so it errs the safe way (see
	 * {@link resolvedViewOf}) and leaves the page unmaterialized rather than
	 * claiming a surface the runtime arranges differently.
	 *
	 * Optional because two callers legitimately want nothing but the page's
	 * *resource* (the review surfaces group rows by it) and have no spec to hand.
	 */
	entities: readonly EntitySpec[] = [],
): PageDescriptor {
	const resource = pageModuleResource(page)
	const view = resolvedViewOf(page, entities)
	const list = view ? undefined : listSurfaceOf(page)
	const replacedBy = view
		? undefined
		: page.blocks
				.filter((b) => isSlotBlockType(b.type) && b.mode === 'replace')
				.map((b) => slotBlockName(b.type))[0]
	const surface = view?.kind === 'unwritable' ? undefined : view
	return {
		resource,
		title: page.name,
		routePath: page.route,
		slots: page.blocks
			.filter((b) => isSlotBlockType(b.type))
			.map((b) => slotBlockName(b.type)),
		...(list ? { list } : {}),
		...(surface ? { view: surface } : {}),
		...(replacedBy ? { listReplacedBy: replacedBy } : {}),
	}
}

/**
 * The page's arranged view, resolved the way the runtime resolves it — the
 * first `calendar`/`timeline`/`board`/`aggregate` block that carries a
 * declaration, in block order.
 *
 * **A deliberate duplicate of `viewOf` in `apps/web/app/project-routes.ts`**,
 * not an import: `@maxstack/mcp` cannot reach into `apps/web` and the runtime
 * must not depend on the generator. Pinned against it by an agreement test
 * (`apps/web/app/project-routes.test.ts`), in the direction that matters —
 * the generator must never claim a surface the runtime arranges differently,
 * because an ejected module replaces the page's *whole* surface.
 *
 * The board rule is the subtle one, and it is the runtime's rule verbatim: the
 * declared options are the columns, so a board whose grouping field has none is
 * not a board and the page falls through to its list. With no entities in hand
 * the block is still treated as a view — unmaterialized is a missed
 * opportunity, a board emitted over a page the runtime lists is a wrong file.
 */
function resolvedViewOf(
	page: PageSpec,
	entities: readonly EntitySpec[],
): PageViewSurface | UnwritableView | undefined {
	const entity = entities.find((e) => e.id === page.entityId)
	for (const block of page.blocks) {
		if (block.type === 'calendar' && block.calendar)
			return { kind: 'calendar', ...block.calendar }
		if (block.type === 'timeline' && block.timeline)
			return { kind: 'timeline', ...block.timeline }
		if (block.type === 'board' && block.board) {
			const options = entity?.fields.find(
				(f) => f.name === block.board?.groupField,
			)?.options
			// No entities to check against ⇒ assume the board draws. Erring the
			// other way would emit a *list* onto a page the runtime boards, which is
			// the failure this whole derivation exists to prevent.
			if (entities.length === 0 || (options && options.length > 0))
				return { kind: 'board', ...block.board }
		}
		// An aggregate is an arranged view the emitter cannot write: it draws a
		// GROUP BY the server computed, which never reaches the rows contract an
		// owned view module is handed. Returned rather than skipped, so the page
		// keeps its placeholder instead of falling through to a list the runtime
		// does not render.
		if (block.type === 'aggregate' && block.aggregate) return UNWRITABLE_VIEW
	}
	// A view block this function has never heard of. `VIEW_BLOCK_TYPES` comes
	// from the spec rather than being restated here for exactly this: the four
	// branches above are a local copy, and a local copy is a list that silently
	// stops including the newest view block. `aggregate` (#299) would otherwise
	// have emitted a plain list over a page the runtime draws as a chart, and
	// this is that guard, arriving one block type early instead of one late.
	//
	// Declaration-*less* blocks of the four known kinds are deliberately not
	// caught here: the runtime skips those and renders the page's list, so
	// mirroring it is what agreement means.
	const unknown = page.blocks.some(
		(b) =>
			(VIEW_BLOCK_TYPES as readonly string[]).includes(b.type) &&
			!KNOWN_VIEW_BLOCKS.includes(b.type),
	)
	return unknown ? UNWRITABLE_VIEW : undefined
}

/** The view block types {@link resolvedViewOf} knows how to answer for. */
const KNOWN_VIEW_BLOCKS: readonly string[] = [
	'calendar',
	'timeline',
	'board',
	'aggregate',
]

/**
 * "This page is arranged, and the emitter cannot write that arrangement" — the
 * one case that still keeps the placeholder, distinct from "no view at all".
 */
interface UnwritableView {
	kind: 'unwritable'
}
const UNWRITABLE_VIEW: UnwritableView = { kind: 'unwritable' }

/**
 * The page's list surface as far as the generator can materialize it, or
 * `undefined` when there is none to materialize (issue #349).
 *
 * **This mirrors the runtime's own derivation** in `apps/web/app/project-routes.ts`
 * (`getRoutes`): same `blocks.find(b => b.type === 'table')` for the variant and
 * fields, same `mode: 'replace'` slot rule. It is a deliberate duplicate rather
 * than an import — `@maxstack/mcp` cannot reach into `apps/web`, and the
 * runtime cannot depend on the generator — and it is pinned by an agreement
 * test (`generators.test.ts`) so the two cannot drift into emitting a list for
 * a page the runtime arranges as a board.
 *
 * View blocks are handled by {@link resolvedViewOf} before this is reached.
 */
function listSurfaceOf(page: PageSpec): PageListSurface | undefined {
	// A `mode: 'replace'` slot owns the list region the moment it is filled.
	// Emitting a list here would contradict a declaration the user already made.
	// The page is still materialized — see `PageDescriptor.listReplacedBy` — it
	// just has no list in it, exactly as the runtime renders none.
	if (page.blocks.some((b) => isSlotBlockType(b.type) && b.mode === 'replace'))
		return
	// No entity behind the page ⇒ no rows, so nothing to list.
	if (!page.entityId) return
	const table = page.blocks.find((b) => b.type === 'table')
	const variant = table?.variant ?? 'table'
	return {
		variant,
		...(table?.fields && table.fields.length > 0
			? { fields: [...table.fields] }
			: {}),
	}
}

/**
 * Descriptors for a whole page list, each carrying the route module it owns —
 * the fold every *writing* or *deriving* caller uses (`maxstack gen`, the `page`
 * generator, `regenTargets`).
 *
 * Module identity has to be decided over the list, not per page: before #337
 * each page folded to its entity's resource, so two pages over `e-book` both
 * emitted `routes/book.tsx`. Every run overwrote the other's file, so
 * `validate`'s regen-safety check reported `unsafe regen overwritten` on every
 * run forever — which also made a *genuine* clobber invisible — and the manifest
 * kept only the last writer while `routes.ts` kept both.
 *
 * **Disambiguate only on collision.** The first page over a resource keeps the
 * bare `routes/<resource>.tsx` it has always had; only a second (third, …) page
 * over that same resource takes a module named for the page. The overwhelmingly
 * common one-page-per-entity project therefore regenerates byte-identically and
 * grows no orphaned files, and even the broken two-page project only *gains* a
 * module — the file the first page has been writing all along keeps its name,
 * its manifest entry and its `routes.ts` line. (Nothing prunes a module that
 * genuinely does go stale — a page deleted, or a resource's first page removed
 * so the second inherits the bare name. That is issue #338's job.)
 *
 * Names are taken from the page id, not from a counter, so they are stable
 * against a later page being added or removed. Collisions with an unrelated
 * resource (a page `pg-author` over `e-book`, in a spec that also has an
 * `author` page) fall back to `<resource>-<stem>`, then a numeric suffix.
 *
 * The fold itself is `pageModuleKeys` in `@maxstack/core/ownership` rather than
 * a local loop, because the *runtime* has to reach the same answer: the mount
 * looks an ejected module up by module key, so a router that folded differently
 * would mount another page's module (#392).
 */
export function pageDescriptors(
	pages: readonly PageSpec[],
	/** The spec's entities — see {@link pageDescriptor}. Every writing caller has them. */
	entities: readonly EntitySpec[] = [],
): PageDescriptor[] {
	const keys = pageModuleKeys(pages)
	return pages.map((page, i) => {
		const descriptor = pageDescriptor(page, entities)
		const key = keys[i]
		// `module` is set only on a collision — the first page over a resource
		// keeps the bare name, and a descriptor carrying `module: resource` would
		// read as "disambiguated" to everything downstream.
		return key === undefined || key === descriptor.resource
			? descriptor
			: { ...descriptor, module: key }
	})
}

/**
 * The `page` generator — for each spec page (or one named `pageId`), run the
 * ownership code generator into a fresh in-memory FS and return the emitted
 * files as artifacts. This drives the real Phase 2 ts-morph emission +
 * never-clobber + slot machinery (`generateResourcePage`) through the MCP
 * surface, so `run_generator` produces actual app route/slot/manifest code, not
 * just spec-derived docs. A disk-backed host swaps the memfs for a real FS to
 * land the files (with eject-safety intact); here we return them for review.
 */
export const pageGenerator: RegisteredGenerator = {
	name: 'page',
	summary:
		'Emit route/slot/manifest code for the spec pages via the ownership ts-morph generator.',
	async run(spec, args): Promise<GeneratorResult> {
		const targetId = typeof args.pageId === 'string' ? args.pageId : undefined
		// Descriptors are derived over the WHOLE page list even when one page is
		// requested: module identity is a fact about the page's siblings, so a
		// single-page preview must not hand back the file name the page would only
		// have had if it were alone in the spec.
		const all = spec.pages.pages
		const descriptors = pageDescriptors(all).filter(
			(_, i) => !targetId || all[i]?.id === targetId,
		)
		if (targetId && descriptors.length === 0)
			throw new PlatformToolError(`Unknown page "${targetId}"`)

		const fs = createMemFs()
		const notes: string[] = []
		for (const descriptor of descriptors) {
			const { results } = await generateResourcePage(fs, descriptor)
			for (const r of results) notes.push(`${r.action}: ${r.file}`)
		}
		const artifacts = [...fs.snapshot()].map(([path, content]) => ({
			path,
			content,
		}))
		if (descriptors.length === 0)
			notes.push('No pages in the spec — nothing to emit.')
		return { generator: 'page', artifacts, notes }
	},
}

// ===========================================================================
// types — per-entity TypeScript for owned code
// ===========================================================================

/**
 * Every line this emits was hand-written, per app, in the dogfood session that
 * motivated it:
 *
 *   type Book = { id: string; title: string; status: Status; … }
 *   type Status = 'want to read' | 'reading' | 'finished' | 'abandoned'
 *   function fromDraft(d: Draft) { … }
 *
 * Each one is derivable from the entity, and each hand-written copy is a place
 * to be wrong. The status union silently drifts the moment somebody adds an enum
 * member through a spec op. The resource is addressed by magic string with the
 * type parameter supplied by hand and checked against nothing. And the payload
 * shaper — the function that gets the empty-string-versus-null question wrong
 * — is written from scratch in every app.
 *
 * Generating them converts that knowledge into compile errors: the union is
 * pinned to the spec, the resource name is a constant, and `toPatch` makes the
 * null bug unreachable from app code.
 *
 * This only pays off paired with a typecheck the project can actually run
 * — types nothing compiles are decoration, which is why the two
 * landed together.
 */

/** A single-quoted TS string literal — the convention the emitted file uses. */
function q(value: string): string {
	return `'${value.replace(/\\/g, '\\\\').replace(/'/g, "\\'")}'`
}

/** `reading-item` → `ReadingItem`. */
function pascal(name: string): string {
	return name
		.split(/[_\-\s]+/)
		.filter(Boolean)
		.map((w) => w.charAt(0).toUpperCase() + w.slice(1))
		.join('')
}

/** The TypeScript for one column's value, ignoring nullability. */
function tsTypeOf(column: SproutColumn, enumName: string): string {
	if (column.meta.arrayReference) return 'string[]'
	switch (column.type) {
		case 'string':
		case 'uuid':
			return 'string'
		case 'number':
			return 'number'
		case 'boolean':
			return 'boolean'
		// A spec `date` crosses the wire as a string, always. Typing it `Date`
		// would be a lie that only shows up at runtime.
		case 'date':
			return 'string'
		case 'enum':
			return (column.enumValues?.length ?? 0) > 0 ? enumName : 'string'
		default:
			return 'unknown'
	}
}

function entityTypes(resource: SproutResource): string {
	const name = pascal(resource.name)
	const lines: string[] = []
	const writable = resource.columns.filter((c) => !c.isPrimaryKey)

	// The enum unions first — they are what drifts.
	for (const column of writable) {
		if (column.type !== 'enum' || !column.enumValues?.length) continue
		lines.push(
			`/** The declared members of ${resource.name}.${column.name}. Pinned to the spec: add one with a spec op and this union changes with it. */`,
			`export type ${name}${pascal(column.name)} =`,
			...column.enumValues.map((v) => `\t| ${q(v)}`),
			'',
		)
	}

	const member = (column: SproutColumn, mode: 'row' | 'patch'): string => {
		const base = tsTypeOf(column, `${name}${pascal(column.name)}`)
		const nullable = column.nullable && column.meta.required !== true
		const optional = mode === 'patch' ? '?' : ''
		return `\t${column.name}${optional}: ${base}${nullable ? ' | null' : ''}`
	}

	lines.push(
		`/** A ${resource.name} row as the API returns it. */`,
		`export interface ${name} {`,
		`\t${resource.primaryKey}: string`,
		...writable.map((c) => member(c, 'row')),
		'}',
		'',
		`/** A PATCH body for ${resource.name}: every field optional, null clears a nullable one. */`,
		`export interface ${name}Patch {`,
		...writable.map((c) => member(c, 'patch')),
		'}',
		'',
	)

	// The payload shaper. Named per entity so the nullable set is baked in
	// rather than passed, which is the part app code kept getting wrong.
	const nullable = writable
		.filter((c) => c.nullable && c.meta.required !== true)
		.map((c) => q(c.name))
	lines.push(
		`/** Fields of ${resource.name} that accept null, i.e. can be cleared. */`,
		`const ${resource.name.toUpperCase().replace(/[^A-Z0-9]/g, '_')}_NULLABLE = new Set<string>([${nullable.join(', ')}])`,
		'',
		`/**`,
		` * Form draft -> PATCH body for ${resource.name}.`,
		` *`,
		` * A form's "empty" is \`""\`; the API's "empty" is \`null\`, and sending \`""\``,
		` * for a date or a number is a 422. This turns one into the other for exactly`,
		` * the fields that accept null, and drops blanks for the ones that do not —`,
		` * because omitting a key leaves it unchanged, which is what a blank input on`,
		` * a non-nullable field actually means.`,
		` */`,
		`export function to${name}Patch(draft: Record<string, unknown>): ${name}Patch {`,
		`\tconst patch: Record<string, unknown> = {}`,
		`\tfor (const [key, value] of Object.entries(draft)) {`,
		`\t\tif (value === '' || value === undefined) {`,
		`\t\t\tif (${resource.name.toUpperCase().replace(/[^A-Z0-9]/g, '_')}_NULLABLE.has(key)) patch[key] = null`,
		`\t\t\tcontinue`,
		`\t\t}`,
		`\t\tpatch[key] = value`,
		`\t}`,
		`\treturn patch as ${name}Patch`,
		`}`,
		'',
	)
	return lines.join('\n')
}

/** The whole generated module for a set of introspected resources. */
export function entityTypesModule(resources: SproutResource[]): string {
	const header = [
		'// GENERATED by `maxstack gen` / run_generator {generator:"types"}. Do not edit.',
		'//',
		'// Every type here is derived from the spec, so it cannot drift from the API:',
		'// add an enum member or a field with a spec op and this file changes with it.',
		'// Import from owned code instead of hand-writing the shapes.',
		'',
	]
	if (resources.length === 0)
		return [
			...header,
			'// No entities in the spec yet — add one and regenerate.',
			'export {}',
			'',
		].join('\n')

	const names = resources.map((r) => r.name)
	return [
		...header,
		...resources.map(entityTypes),
		'/** Every resource name, pinned to the spec — no magic strings in app code. */',
		`export const RESOURCES = {`,
		...names.map((n) => `\t${q(n)}: ${q(n)},`),
		`} as const`,
		'',
		'export type ResourceName = (typeof RESOURCES)[keyof typeof RESOURCES]',
		'',
		'/** Resource name -> its row type, for `useList<RecordOf<"book">>(RESOURCES.book)`. */',
		'export interface ResourceRecords {',
		...resources.map((r) => `\t${q(r.name)}: ${pascal(r.name)}`),
		'}',
		'',
		'export type RecordOf<K extends ResourceName> = ResourceRecords[K]',
		'',
	].join('\n')
}

export const typesGenerator: RegisteredGenerator = {
	name: 'types',
	summary:
		'Per-entity TypeScript for owned code: row + patch types, enum unions pinned to the spec, resource-name constants, and a toPatch() that gets empty-vs-null right.',
	run(spec): GeneratorResult {
		const resources = groundedEntityShapes(spec).map((shape) =>
			introspectTable(tableFromSpecEntity(shape)),
		)
		return {
			generator: 'types',
			artifacts: [
				{
					// Relative to the app directory, like every other artifact here —
					// a disk host writes these through an fs rooted at `appPath`.
					path: 'generated/types.ts',
					content: entityTypesModule(resources),
				},
			],
			notes: [
				`Generated types for ${counted(resources.length, 'resource')}: ${resources.map((r) => r.name).join(', ') || '(none)'}.`,
			],
		}
	},
}

/** The generators the platform ships with by default. */
export const BUILT_IN_GENERATORS: RegisteredGenerator[] = [
	pageGenerator,
	docsGenerator,
	e2eTestsGenerator,
	typesGenerator,
]

/** A runner over the built-in generators. */
export function defaultGeneratorRunner(): GeneratorRunner {
	return createGeneratorRegistry(BUILT_IN_GENERATORS)
}
