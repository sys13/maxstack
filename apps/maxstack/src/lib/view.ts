/**
 * The `maxstack add view <resource>` scaffolder — the tier-3 analog of
 * `maxstack gen`, and the infer-then-eject workflow made a first-class CLI verb
 * (Plan v5 task 36).
 *
 * `gen` emits a *framework-owned* thin route shell; `add view` emits the
 * **guesser output**: an *owned* route module with the inferred columns written
 * out explicitly as `<ResourceList>` props, that the author then edits and the
 * generator never regenerates over. The whole file is the eject seam — start
 * from inference, hand-edit the one cell you care about, the rest stays inferred.
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
import { groundedEntityShapes } from '@maxstack/mcp'
import type { SpecSystem } from '@maxstack/spec'

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

/** Serialize an introspected resource to a clean, hand-editable TS object
 * literal — projected to exactly the `IntrospectedResource` display shape so the
 * emitted `satisfies IntrospectedResource` never trips an excess-property check
 * (`SproutResource` carries `hasDefault`/`isPrimaryKey`/`relations` the read side
 * ignores). Non-serializable metadata (e.g. a RegExp `pattern`) is dropped so the
 * file always parses; spec-derived resources never carry those. */
function introspectionLiteral(resource: SproutResource): string {
	const projected = {
		name: resource.name,
		primaryKey: resource.primaryKey,
		columns: resource.columns.map((c) => ({
			name: c.name,
			type: c.type,
			nullable: c.nullable,
			...(c.enumValues ? { enumValues: c.enumValues } : {}),
			...(c.references ? { references: c.references } : {}),
			meta: c.meta ?? {},
		})),
	}
	const clean = JSON.parse(
		JSON.stringify(projected, (_key, value) =>
			value instanceof RegExp || typeof value === 'function'
				? undefined
				: value,
		),
	)
	return JSON.stringify(clean, null, '\t')
}

/** Render the owned view module — the "guesser output" for a resource. */
export function renderViewModule(view: ResolvedView): string {
	const { resource, pascal: P, introspection, titleField } = view
	const label = formatLabel(resource)

	// The one demonstrated eject: emphasize the title cell. Everything else stays
	// inferred by <ResourceList>. Omitted entirely when there is no string field.
	const columnsBlock = titleField
		? `
	// The eject seam: override exactly the cells you care about — the rest stay
	// inferred from the schema above. Delete this to fall fully back to inference.
	const columns = useMemo(
		() => ({
			${JSON.stringify(titleField)}: ({ value }: { value: unknown }) => (
				<span className="font-medium">{String(value ?? '—')}</span>
			),
		}),
		[],
	)
`
		: ''
	const columnsProp = titleField ? '\n\t\t\t\tcolumns={columns}' : ''

	return `// Scaffolded by \`maxstack add view ${resource}\` — THIS FILE IS YOURS.
//
// It began as inferred "guesser output": the \`introspection\` object below was
// derived from your spec and written out explicitly, and <ResourceList> renders
// every column from it. Edit any of it — reorder columns, relabel, swap a cell —
// and \`maxstack gen\` will never overwrite it (this route is \`ejected\` in the
// route manifest). The workflow: start inferred → eject the one cell you care
// about → the rest stays inferred.
import { useMemo } from 'react'
import {
	createRestDataProvider,
	DataProvider,
	type IntrospectedResource,
	NotificationProvider,
	Notifications,
	ResourceList,
	useList,
} from '@maxstack/ui'

export const meta = { resource: ${JSON.stringify(resource)}, view: true }

// The inferred schema, written out explicitly (the guesser output). A plain data
// object — edit column order, labels, or metadata right here.
const introspection = ${introspectionLiteral(introspection)} satisfies IntrospectedResource

function ${P}List() {
	// Typed, cached client-side fetch (task 33) — no loader wiring needed, so the
	// view is self-contained wherever the runtime composes it.
	const { data: rows = [], isLoading } = useList(${JSON.stringify(resource)}, {
		pagination: { page: 1, perPage: 50 },
	})
${columnsBlock}
	return (
		<section data-view="${resource}">
			<h1 className="mb-4 text-2xl font-semibold">${label}</h1>
			<ResourceList
				resource={introspection}
				rows={rows}
				loading={isLoading}${columnsProp}
				pageSize={10}
			/>
		</section>
	)
}

// Self-contained: mounts its own data + notification providers so the view works
// wherever it is rendered (the owned-route runtime seam supplies no ambient
// providers). Remove these wrappers if you mount them higher up your tree.
export default function ${P}View() {
	const dataProvider = useMemo(() => createRestDataProvider(), [])
	return (
		<NotificationProvider>
			<DataProvider dataProvider={dataProvider}>
				<${P}List />
				<Notifications />
			</DataProvider>
		</NotificationProvider>
	)
}
`
}

/** The repo-relative path of a resource's view module (within the app dir). */
export function viewFile(resource: string): string {
	return `routes/${resource}.tsx`
}
