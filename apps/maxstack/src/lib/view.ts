/**
 * The `maxstack add view <resource>` scaffolder — the infer-then-eject workflow
 * made a first-class CLI verb (Plan v5 task 36).
 *
 * `gen` emits a *framework-owned* route module; `add view` emits an **owned**
 * one, pre-ejected, whose whole reason to exist is the cell-override seam: the
 * inferred title cell written out as an editable `columns` entry that the author
 * hand-edits and the generator never regenerates over.
 *
 * ## One owned-page shape, not two (issue #356)
 *
 * `add view` and `maxstack eject` land in the same place — `OWNED_ROUTES`,
 * rendered by `project.page.tsx` — so they emit against the same contract:
 * {@link OwnedRouteProps}. The route's loader has already fetched the rows,
 * introspected the columns, computed the viewer's capabilities and resolved FK
 * titles and signed file URLs; an owned module is handed all of it and renders
 * from it.
 *
 * Until #356 this emitter did the opposite. It wrote a props-less module that
 * mounted its own `DataProvider` and re-fetched the same rows over REST from the
 * browser, against a **frozen copy** of the introspection baked in at scaffold
 * time. That double-fetched on every navigation, flashed an empty list on a page
 * whose data was already in the loader payload, dropped the resolved references
 * and file URLs entirely (FK cells rendered raw ids, file cells unsigned keys),
 * and went stale against the schema the moment a field was added.
 *
 * The frozen literal is gone rather than moved: the emitted module reads
 * `list.resource`, which the loader introspects live on every request. What
 * survives is the part that was always the point — a named, hand-editable
 * override per cell, merged *over* inference rather than replacing it, so a
 * field added to the spec still shows up without touching this file.
 *
 * A module emitted in the old shape keeps working untouched: it takes no props,
 * so the props it is now handed are simply ignored and it renders exactly as it
 * did. Re-running `maxstack add view` is the opt-in upgrade.
 *
 * Pure w.r.t. the filesystem: this module builds the introspection and renders
 * the file *content*; the command (`commands/view.ts`) decides where it lands
 * and flips the route to `ejected` in the manifest so `gen` skips it.
 */

import {
	formatLabel,
	pickTitleField,
	ResourceRegistry,
	registerSpecEntities,
	type SpecEntityShape,
	type SproutResource,
} from '@maxstack/core'
import {
	NEW_LINK_CLASS,
	type PageListSurface,
	pageModuleKeys,
	pageModuleResource,
	VARIANT_COMPONENT,
} from '@maxstack/core/ownership'
import { groundedEntityShapes } from '@maxstack/mcp'
import { getAcceptedOrAll, type PageSpec, type SpecSystem } from '@maxstack/spec'

/** `e-reading-item` → `reading-item` — the same derivation the page generator's
 * `pageDescriptor` and the web app's grounding use, so tables, routes, and views
 * all agree on resource names. */
const resourceName = (entityId: string) => entityId.replace(/^e-/, '')

/** PascalCase identifier for a resource — `reading-item` → `ReadingItem`. Used
 * for the generated component names. */
function pascal(name: string): string {
	return name
		.split(/[_\-\s]+/)
		.filter(Boolean)
		.map((w) => w.charAt(0).toUpperCase() + w.slice(1))
		.join('')
}

export interface ResolvedView {
	resource: string
	pascal: string
	introspection: SproutResource
	/** The name-ish string column (never an FK) — the natural title cell to
	 * demonstrate the eject seam with; `undefined` when the resource has none. */
	titleField?: string
}

/** Introspect a resource out of a project's spec, or throw with the known list.
 * The returned `introspection` is the same `SproutResource` the runtime builds,
 * so a view scaffolded from it renders identically to the generic admin. */
export function resolveView(spec: SpecSystem, resource: string): ResolvedView {
	const registry = new ResourceRegistry()
	registerSpecEntities(registry, groundedEntityShapes(spec))
	const entry = registry.get(resource)
	if (!entry) {
		const known = registry
			.all()
			.map((r) => r.resource.name)
			.join(', ')
		throw new Error(
			`unknown resource "${resource}". Known resources: ${known || '(none — add an entity to the spec first)'}`,
		)
	}
	const introspection = entry.resource
	// Same pick the runtime makes: never an FK column — its value is
	// the referenced row's id, a meaningless (and misleading) title cell.
	const titleField = pickTitleField(
		introspection.columns.filter((c) => c.name !== introspection.primaryKey),
	)
	return { resource, pascal: pascal(resource), introspection, titleField }
}

/**
 * What `maxstack add view <target>` decided to scaffold: one **page**, not a
 * resource (issue #434).
 *
 * The whole ownership path downstream of this — eject, the manifest, the
 * never-clobber writer, `OWNED_ROUTES` — is page-scoped, because a page is the
 * unit a user owns. `add view` was the last entry point still speaking in
 * resources, and it wrote its manifest entry under the bare resource. That
 * agreed with the generator only when the entity had exactly one page: on a
 * second page it named a module the mount looks up under a different key
 * (#337/#392), so the file landed where nothing rendered it.
 */
export interface ViewTarget {
	/** The resource whose columns the module renders — never null: a page with
	 * no entity has no list to scaffold and is refused before this is built. */
	resource: string
	/** The manifest id and file stem — `pageModuleKey` of {@link page}, or the
	 * bare resource when the spec has no page over it yet. */
	moduleKey: string
	/** The page the module will render at; absent for a resource with no page. */
	page?: PageSpec
}

/** A target that could only ever have been meant as a page — a route path or a
 * page id — so a miss says "no such page" instead of "unknown resource". */
const looksLikePageRef = (target: string) =>
	target.startsWith('/') || target.startsWith('pg-')

/** `maxstack add view <route>` for each candidate — routes are unique and can
 * never be mistaken for a resource name, so they are the unambiguous handle to
 * suggest when a bare resource is not. */
const suggestions = (pages: readonly PageSpec[], keyOf: Map<string, string>) =>
	pages
		.map(
			(p) =>
				`\n      maxstack add view ${p.route}   # "${p.name}" → routes/${keyOf.get(p.id)}.tsx`,
		)
		.join('')

/**
 * Resolve what the user named — a resource, a page id, a module key or a route
 * path — to the single page the scaffold lands on (issue #434).
 *
 * A bare resource is read as a resource *first*, even though the first page over
 * it also carries that name as its module key: `add view task` on a two-page
 * entity must say so rather than quietly take the first page, which is exactly
 * the failure this replaces. One page over the resource keeps the old
 * ergonomics; zero pages keeps the orphan path the command already warns about.
 *
 * Module keys are folded over the **whole** page list, unfiltered, because the
 * generator and the runtime mount both do (#392) — a key derived from only the
 * accepted pages would name a file that is not on disk. Matching then happens
 * against the accepted-or-all pages, which are the ones that actually render.
 */
export function resolveViewTarget(
	spec: SpecSystem,
	target: string,
): ViewTarget {
	const keys = pageModuleKeys(spec.pages.pages)
	const keyOf = new Map(
		spec.pages.pages.map((p, i) => [p.id, keys[i] ?? pageModuleResource(p)]),
	)
	const pages = getAcceptedOrAll(spec.pages.pages)
	const pageTarget = (page: PageSpec): ViewTarget => {
		if (!page.entityId) {
			throw new Error(
				`page "${page.name}" (${page.id}) has no entity, so there is no list to` +
					'\n  scaffold. `add view` writes a module over a resource\'s rows; for a' +
					'\n  page that arranges something else, take the generated module over' +
					`\n  with:\n      maxstack eject ${keyOf.get(page.id)}`,
			)
		}
		return {
			resource: resourceName(page.entityId),
			moduleKey: keyOf.get(page.id) ?? pageModuleResource(page),
			page,
		}
	}

	// A resource name first. `over` is the fact that decides everything: the
	// bare name is only unambiguous when at most one page claims it.
	const isResource = getAcceptedOrAll(spec.data.entities).some(
		(e) => resourceName(e.id) === target,
	)
	if (isResource) {
		const over = pages.filter(
			(p) => p.entityId && resourceName(p.entityId) === target,
		)
		if (over.length > 1) {
			throw new Error(
				`"${target}" has ${over.length} pages, so "add view ${target}" cannot tell` +
					'\n  which one you mean — and each page is a separate owned module.' +
					'\n' +
					`\n  Name the page (its route, its id, or the module file gen wrote):${suggestions(over, keyOf)}`,
			)
		}
		// Zero pages is the orphan case the command warns about and still
		// scaffolds; the module key is the resource, which is what gen would use
		// once a page appears.
		return over[0]
			? pageTarget(over[0])
			: { resource: target, moduleKey: target }
	}

	// …then a page, by route path, page id, or the module key gen filed it under.
	const named = pages.find(
		(p) => p.route === target || p.id === target || keyOf.get(p.id) === target,
	)
	if (named) return pageTarget(named)
	if (looksLikePageRef(target)) {
		throw new Error(
			`no page "${target}" in the spec.` +
				(pages.length > 0
					? `\n  Known pages:${suggestions(pages, keyOf)}`
					: '\n  This spec has no pages yet.'),
		)
	}
	// Neither: let the registry throw, with the known-resource list.
	return { resource: target, moduleKey: target }
}

/** An object-literal key: bare when the column name is an identifier, quoted
 * (single, the repo's style) when it is not. */
function key(name: string): string {
	return /^[A-Za-z_$][A-Za-z0-9_$]*$/.test(name) ? name : `'${name}'`
}

/**
 * Render the owned view module for a resource.
 *
 * The body is `<ResourceList {...list} …/>` — the same one line `eject` emits,
 * for the same reason: it is what keeps a hand-owned page working when the
 * runtime learns to pass something new. The one thing this verb adds on top is
 * the `columns` override map.
 *
 * `surface` is the page's declared list surface (`pageDescriptor(page).list`),
 * when the resource has a page to render at. It selects the list component
 * through the *same* {@link VARIANT_COMPONENT} map `emit.ts` uses: until issue
 * #360 this emitter hardcoded `ResourceList`, so scaffolding a view onto a page
 * the spec declares as `cards` or `feed` silently rewrote it as a table — the
 * quieter cousin of the board downgrade the command already warns about.
 * Omitted (or `table`) keeps the table.
 */
export function renderViewModule(
	view: ResolvedView,
	surface?: PageListSurface,
	/** What the user typed to reach this module — quoted back in the banner so
	 * the re-run it names is the one that lands here. Defaults to the resource,
	 * which is the whole invocation on a one-page entity. */
	invocation: string = view.resource,
): string {
	const { resource, pascal: P, titleField } = view
	const label = formatLabel(resource)
	const variant = surface?.variant ?? 'table'
	const listComponent = VARIANT_COMPONENT[variant]
	// Only cards and feed read the declared field subset (as their
	// primary/secondary fields); a table's columns come from introspection, which
	// no literal here could stand in for. Same rule as `listSurfaceJsx`.
	const fields =
		variant !== 'table' && surface?.fields?.length ? surface.fields : undefined

	// The one demonstrated eject: emphasize the title cell. Every other column
	// stays inferred from the *live* introspection the loader hands down.
	// Omitted entirely when the resource has no string field to demonstrate on.
	const columnsBlock = titleField
		? `
// The eject seam, and the whole reason this file exists: name a column, own its
// cell. Merged OVER the inferred rendering below, so every column you do not
// name here keeps its inferred cell — enum chips, formatted dates, resolved
// reference titles, signed file links — and a field added to the spec later
// shows up without an edit here.
const columns: ColumnOverrides = {
	${key(titleField)}: ({ value }) => (
		<span className="font-medium">{String(value ?? '—')}</span>
	),
}
`
		: ''
	// `list.columns` carries the project's filled `field` block slots, so the
	// overrides above are merged onto them rather than replacing them — taking
	// one cell here must not silently unfill a slot somewhere else.
	//
	// The field literals are inlined rather than hoisted into the `LIST_FIELDS`
	// const `emit.ts` uses: that file is the framework's and is rewritten whole,
	// this one is the user's and its first edit is usually one of these names.
	const listProps = [
		'{...list}',
		...(titleField ? ['columns={{ ...list.columns, ...columns }}'] : []),
		...(fields
			? [
					`primaryField="${fields[0]}"`,
					`secondaryFields={[${fields.map((f) => `'${f}'`).join(', ')}]}`,
				]
			: []),
	]
	const oneLineJsx = `<${listComponent} ${listProps.join(' ')} />`
	// Biome-shaped by hand: a scaffold that arrives already reformatted by the
	// project's own `lint --write` is a scaffold whose first diff is noise. The
	// JSX sits three tabs deep, so 76 is the budget before it wraps one-per-line.
	const listJsx =
		oneLineJsx.length <= 76
			? oneLineJsx
			: `<${listComponent}\n${listProps
					.map((p) => `\t\t\t\t${p}`)
					.join('\n')}\n\t\t\t/>`
	// Under 80 columns it stays on one line; the three-binding form does not fit.
	const bindings = [
		...(titleField ? ['type ColumnOverrides'] : []),
		'type OwnedRouteProps',
		listComponent as string,
		// Sorted on the *binding*, not the `type ` prefix — the order biome's
		// import organizer would settle on, so the scaffold's first lint is a no-op.
	].sort((a, b) => a.replace('type ', '').localeCompare(b.replace('type ', '')))
	const oneLine = `import { ${bindings.join(', ')} } from '@maxstack/ui'`
	const importBlock =
		oneLine.length <= 80
			? oneLine
			: `import {\n${bindings.map((b) => `\t${b},\n`).join('')}} from '@maxstack/ui'`

	return `// Scaffolded by \`maxstack add view ${invocation}\` — THIS FILE IS YOURS.
//
// \`maxstack gen\` will never overwrite it: this route is \`ejected\` in the route
// manifest, so your edits survive regeneration (and it stops receiving generator
// improvements — the eject tax).
//
// What you own is this page's RENDER. What still runs framework code is the
// LOADER: the rows, the introspected columns, the viewer's permissions, the
// resolved reference titles and the signed file URLs are all produced from
// \`spec/\` on every request and handed to this module as props
// (\`OwnedRouteProps\`). Spreading \`{...list}\` is what draws the real page; this
// page therefore still depends on its spec entry.
${importBlock}

export const meta = { resource: '${resource}', view: true }
${columnsBlock}
export default function ${P}View({
	list,
	newHref,
	toolbar,
	Link,
}: OwnedRouteProps) {
	return (
		<section data-view="${resource}">
			<header className="mb-4 flex items-center justify-between">
				<h1 className="text-2xl font-semibold">${label}</h1>
				<Link
					to={newHref}
					className="${NEW_LINK_CLASS}"
				>
					+ New
				</Link>
			</header>
			{/* Search, the derived filter facets and CSV export, wired to the URL by
			    the framework's loader. Move it, or delete it and lose them. */}
			{toolbar}
			${listJsx}
		</section>
	)
}
`
}

/**
 * The repo-relative path of a view module (within the app dir).
 *
 * Keyed by the page's **module key**, not its resource (#434) — the same stem
 * `generateResourcePage` files the generated module under, so an owned module
 * for the second page over an entity lands where the mount looks for it.
 */
export function viewFile(moduleKey: string): string {
	return `routes/${moduleKey}.tsx`
}
