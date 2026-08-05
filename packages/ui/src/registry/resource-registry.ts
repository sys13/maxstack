/**
 * The resource registry (Plan v5 task 41) — the tier-3 analog of react-admin's
 * `<Resource>`. Register a resource once (its introspection + which views it has
 * + a capability gate) and the app chrome derives from it: menu entries, route
 * paths, and breadcrumbs, each hidden when the session can't access it. Pure and
 * framework-agnostic (no React, no router) so it tests without a DOM and any
 * router can consume the derived paths. The `maxstack add view` scaffolder
 * (task 36) registers into this.
 */

import { humanizeLabel } from '../fields/field-semantics.ts'
import type { ResourceCapabilities } from '../resource/resource-types.ts'

/** Which standard views a resource exposes. Absent flags default to `true` for
 * `list`/`show` and to the presence of a create/edit form otherwise — but the
 * registry keeps them explicit so the menu/routes reflect exactly what exists. */
export interface ResourceViews {
	list?: boolean
	show?: boolean
	create?: boolean
	edit?: boolean
}

export interface ResourceDefinition {
	/** URL/registry key, e.g. `post`. */
	name: string
	/** Menu label (defaults to a title-cased `name`). */
	label?: string
	/** Plural menu/heading label (defaults to `label` + "s"). */
	pluralLabel?: string
	/** An icon token (emoji or name) the menu renders; presentation is the app's. */
	icon?: string
	/** Which views exist (default: list + show + create + edit all on). */
	views?: ResourceViews
	/** The capability action that gates *visibility* in the menu (default `read`). */
	requires?: keyof ResourceCapabilities
	/** Sort weight in the menu (lower first; default insertion order). */
	order?: number
}

export interface ResourceRegistry {
	register(def: ResourceDefinition): ResourceRegistry
	get(name: string): ResolvedResource | undefined
	all(): ResolvedResource[]
	/** Menu entries visible under the given per-resource capabilities. */
	menu(caps?: Record<string, ResourceCapabilities>): MenuEntry[]
	routes(): ResourceRoute[]
}

export interface ResolvedResource
	extends Required<Omit<ResourceDefinition, 'order'>> {
	order: number
	views: Required<ResourceViews>
}

export interface MenuEntry {
	name: string
	label: string
	icon?: string
	href: string
}

export interface ResourceRoute {
	name: string
	kind: 'list' | 'show' | 'create' | 'edit'
	/** Path pattern with `:id` for record routes (`/post`, `/post/:id`, …). */
	path: string
}

const ALL_ALLOWED: ResourceCapabilities = {
	read: true,
	create: true,
	update: true,
	delete: true,
}

function resolve(def: ResourceDefinition, insertion: number): ResolvedResource {
	const label = def.label ?? humanizeLabel(def.name)
	return {
		name: def.name,
		label,
		pluralLabel: def.pluralLabel ?? `${label}s`,
		icon: def.icon ?? '',
		requires: def.requires ?? 'read',
		order: def.order ?? insertion,
		views: {
			list: def.views?.list ?? true,
			show: def.views?.show ?? true,
			create: def.views?.create ?? true,
			edit: def.views?.edit ?? true,
		},
	}
}

/** The base path a resource's routes hang off (`/post`). Overridable later if a
 * custom mount is ever needed; kept a plain helper for now. */
export function resourceBasePath(name: string): string {
	return `/${name}`
}

export function createResourceRegistry(
	defs: ResourceDefinition[] = [],
): ResourceRegistry {
	const map = new Map<string, ResolvedResource>()
	let counter = 0

	const registry: ResourceRegistry = {
		register(def) {
			map.set(def.name, resolve(def, counter++))
			return registry
		},
		get(name) {
			return map.get(name)
		},
		all() {
			return [...map.values()].sort((a, b) => a.order - b.order)
		},
		menu(caps) {
			return registry
				.all()
				.filter((r) => r.views.list)
				.filter((r) => {
					const c = caps?.[r.name] ?? ALL_ALLOWED
					return c[r.requires]
				})
				.map((r) => ({
					name: r.name,
					label: r.pluralLabel,
					icon: r.icon || undefined,
					href: resourceBasePath(r.name),
				}))
		},
		routes() {
			const out: ResourceRoute[] = []
			for (const r of registry.all()) {
				const base = resourceBasePath(r.name)
				if (r.views.list) out.push({ name: r.name, kind: 'list', path: base })
				if (r.views.create)
					out.push({ name: r.name, kind: 'create', path: `${base}/new` })
				if (r.views.show)
					out.push({ name: r.name, kind: 'show', path: `${base}/:id` })
				if (r.views.edit)
					out.push({ name: r.name, kind: 'edit', path: `${base}/:id/edit` })
			}
			return out
		},
	}

	for (const def of defs) registry.register(def)
	return registry
}

/** Build the breadcrumb trail for a location within a registered resource —
 * `[Home, Posts, <id>]`-style. `kind`/`id` describe where in the resource the
 * user is. Home is included unless `home` is `null`. */
export interface Crumb {
	label: string
	href?: string
}

export function breadcrumbsFor(
	registry: ResourceRegistry,
	resourceName: string,
	options: {
		kind?: 'list' | 'show' | 'create' | 'edit'
		id?: string
		home?: { label: string; href: string } | null
	} = {},
): Crumb[] {
	const crumbs: Crumb[] = []
	const home =
		options.home === undefined ? { label: 'Home', href: '/' } : options.home
	if (home) crumbs.push(home)

	const resource = registry.get(resourceName)
	if (!resource) return crumbs

	const base = resourceBasePath(resource.name)
	const kind = options.kind ?? 'list'
	// The resource list is always a crumb; it's a link unless we're already on it.
	crumbs.push({
		label: resource.pluralLabel,
		href: kind === 'list' ? undefined : base,
	})

	if (kind === 'create') crumbs.push({ label: 'New' })
	else if (kind === 'show' && options.id != null)
		crumbs.push({ label: options.id })
	else if (kind === 'edit' && options.id != null) {
		crumbs.push({ label: options.id, href: `${base}/${options.id}` })
		crumbs.push({ label: 'Edit' })
	}
	return crumbs
}
