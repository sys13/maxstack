/**
 * Resource registry. See the reference design.
 *
 * A module singleton keyed by DB table name. Registration is explicit and by
 * import side-effect (a project's sprout.config calls `sprout.resource(...)`
 * once per table); there is no filesystem auto-discovery.
 */

import type { PgTable } from 'drizzle-orm/pg-core'
import type { DocumentPlan } from './documents.ts'
import type { ImportPlanShape } from './imports.ts'
import { introspectTable } from './introspection.ts'
import type { LivePlan } from './live.ts'
import type { ResourceAccess } from './permissions.ts'
import type { PortalPlan } from './portals.ts'
import type { SearchIndexPlan } from './search.ts'
import type { SproutResource } from './types.ts'

export interface ResourceConfig {
	/** Human label; defaults to a Title-Cased table name. */
	label?: string
	/** Grouping bucket for the admin nav; defaults to 'Other'. */
	group?: string
	icon?: string
	/** Column used as the display title in tables/links. */
	titleField?: string
	access?: ResourceAccess
	/** Tenant column (d-tenancy-model): naming a column here makes the resource
	 * org-scoped — every op filters/stamps it with the request's active org
	 * (`user.orgId`), and access without an active org is denied. Declared per
	 * resource like `access`, so single-tenant resources pay nothing. */
	tenantField?: string
	/** Soft delete (GDPR retention): when `true`, the resource must
	 * have a nullable `deletedAt` timestamp column. `opDelete` stamps it instead
	 * of removing the row; `opList`/`opCount`/`opGet`/`opGetMany` filter it out
	 * by default (`deletedAt IS NULL`), with an explicit `includeDeleted` escape
	 * hatch on read ops; `opRestore` clears it. A scheduled purge job (see
	 * `@maxstack/features/compliance`) hard-deletes rows past the retention
	 * window. Declared per resource like `tenantField`, so resources that don't
	 * opt in pay nothing and keep today's hard-delete semantics. */
	softDelete?: boolean
	/**
	 * A declared full-text index, grounded to column names.
	 *
	 * Naming it here is what makes ranked search reachable from `opSearch`, which
	 * is the same chokepoint `authorize()` guards. Put anywhere shallower — a
	 * route, a loader — and search would be the one read path that does not pass
	 * the gate the REST routes lost in issue #186. Resources with no declared
	 * index simply have no search endpoint; nothing degrades to an unranked scan
	 * behind a name that promises ranking.
	 */
	search?: SearchIndexPlan
	/**
	 * Declared document templates for this resource, grounded to
	 * column names.
	 *
	 * Here for the same reason `search` is, and the argument is if anything
	 * sharper: rendering a document is a *read* of the row, so it has to happen
	 * below the routes, at the layer `authorize()` guards. A document route that
	 * fetched its own row would be a second read path with a second gate — and
	 * issue #186's finding was that the second gate is the one that gets skipped.
	 * `opRenderDocument` reuses `opGet` and `opList` outright rather than
	 * re-implementing either.
	 *
	 * Several per resource, unlike a search index: an invoice, a receipt and a
	 * statement are three documents about one row.
	 */
	documents?: DocumentPlan[]
	/**
	 * Declared importers for this resource, grounded to column names.
	 *
	 * Here for the reason `search` and `documents` are, and the argument is at its
	 * sharpest: an import is a *write*, so it has to happen below the routes, at
	 * the layer `authorize()` guards. An upload route that wrote its own rows would
	 * be a second write path with a second gate, and issue #186's finding was that
	 * the second gate is the one that gets skipped. `planImport`/`opApplyImport`
	 * reuse `opList`, `opCreate` and `opUpdate` outright rather than
	 * re-implementing any of them.
	 *
	 * Several per resource, like documents: "the CSV our old tool exports" and "an
	 * Anki deck" are two different files about one table.
	 */
	importers?: ImportPlanShape[]
	/**
	 * Declared portals for this resource, grounded to column names.
	 *
	 * Here for the reason everything above is here, and this is the entry that
	 * makes the reason non-negotiable: a portal decides what somebody who has
	 * never signed in may read. `portalGrants` and `projectForPortal` both key off
	 * the identity rather than off this list, so the registry's copy is what the
	 * *route* looks a portal up in — but the enforcement is already below it, and
	 * a route that never found the plan simply serves nothing.
	 *
	 * Several per resource: a public archive and a client portal are two different
	 * outsides on one table.
	 */
	portals?: PortalPlan[]
	/**
	 * Declared live channels for this resource, grounded to column
	 * names.
	 *
	 * Here for `portals`' reason with a different edge. A portal decides what an
	 * outsider may read once; a channel decides what the app pushes, repeatedly,
	 * to people who are already inside. The enforcement is again below this list —
	 * `LiveChannel.publish` re-authorizes per message through `opList` — so the
	 * registry's copy is only what the SSE route looks a channel up in, and a
	 * route that never found the plan simply serves nothing.
	 *
	 * At most two per resource: one `query` and one `presence`. Unlike a portal,
	 * a channel is not an audience — its cost lands on every write to the table,
	 * so a second one is a second cost chosen by nobody. The spec validator
	 * enforces the cardinality; this is a plain array because the registry is a
	 * lookup table rather than a second validator.
	 */
	live?: LivePlan[]
	/** Extra synchronous validation run after the generated Zod schema. */
	customValidation?: (
		data: Record<string, unknown>,
		mode: 'create' | 'update',
	) => void
}

export interface RegisteredResource {
	table: PgTable
	resource: SproutResource
	config: ResourceConfig
	label: string
}

/** snake_case / camelCase → Title Case. `blog_post` → `Blog Post`. */
export function formatLabel(name: string): string {
	return name
		.replace(/([a-z0-9])([A-Z])/g, '$1 $2')
		.split(/[_\s]+/)
		.filter(Boolean)
		.map((w) => w.charAt(0).toUpperCase() + w.slice(1))
		.join(' ')
}

export class ResourceRegistry {
	private readonly resources = new Map<string, RegisteredResource>()

	register(table: PgTable, config: ResourceConfig = {}): RegisteredResource {
		const resource = introspectTable(table)
		const entry: RegisteredResource = {
			table,
			resource,
			config,
			label: config.label ?? formatLabel(resource.name),
		}
		this.resources.set(resource.name, entry)
		return entry
	}

	get(name: string): RegisteredResource | undefined {
		return this.resources.get(name)
	}

	has(name: string): boolean {
		return this.resources.has(name)
	}

	/**
	 * Find a declared document template by key, across every resource.
	 *
	 * Keys are unique spec-wide (the validator refuses a duplicate), so this is a
	 * lookup rather than a search. It lives on the registry because the document
	 * route is keyed on the template, not on the resource — a person following a
	 * link has the document's name, not the table's.
	 */
	findDocument(
		key: string,
	): { entry: RegisteredResource; plan: DocumentPlan } | undefined {
		for (const entry of this.resources.values()) {
			const plan = entry.config.documents?.find((d) => d.key === key)
			if (plan) return { entry, plan }
		}
		return undefined
	}

	/**
	 * Find a declared importer by key, across every resource.
	 *
	 * Keys are unique spec-wide (the validator refuses a duplicate), so this is a
	 * lookup rather than a search. It lives on the registry for `findDocument`'s
	 * reason: the upload route is keyed on the importer, not on the resource — the
	 * person following the link has the importer's name, not the table's.
	 */
	findImporter(
		key: string,
	): { entry: RegisteredResource; plan: ImportPlanShape } | undefined {
		for (const entry of this.resources.values()) {
			const plan = entry.config.importers?.find((i) => i.key === key)
			if (plan) return { entry, plan }
		}
		return undefined
	}

	/**
	 * Find a declared portal by key, across every resource.
	 *
	 * Keys are unique spec-wide (the validator refuses a duplicate), so this is a
	 * lookup rather than a search. It lives on the registry for `findDocument`'s
	 * and `findImporter`'s reason: the public URL is keyed on the portal, not on
	 * the resource — somebody following a link has the portal's name and has never
	 * heard of the table.
	 */
	findPortal(
		key: string,
	): { entry: RegisteredResource; plan: PortalPlan } | undefined {
		for (const entry of this.resources.values()) {
			const plan = entry.config.portals?.find((p) => p.key === key)
			if (plan) return { entry, plan }
		}
		return undefined
	}

	/**
	 * Find a declared live channel by key, across every resource.
	 *
	 * Keys are unique spec-wide (the validator refuses a duplicate), so this is a
	 * lookup rather than a search. It lives on the registry for `findPortal`'s
	 * reason: the stream URL is keyed on the channel, not on the resource — a
	 * client reconnecting has the channel's name and an incident report quotes it.
	 */
	findLive(
		key: string,
	): { entry: RegisteredResource; plan: LivePlan } | undefined {
		for (const entry of this.resources.values()) {
			const plan = entry.config.live?.find((l) => l.key === key)
			if (plan) return { entry, plan }
		}
		return undefined
	}

	all(): RegisteredResource[] {
		return [...this.resources.values()].sort((a, b) => {
			const ga = a.config.group ?? 'Other'
			const gb = b.config.group ?? 'Other'
			return ga === gb ? a.label.localeCompare(b.label) : ga.localeCompare(gb)
		})
	}

	allGrouped(): Record<string, RegisteredResource[]> {
		const grouped: Record<string, RegisteredResource[]> = {}
		for (const entry of this.all()) {
			const group = entry.config.group ?? 'Other'
			const bucket = grouped[group] ?? []
			bucket.push(entry)
			grouped[group] = bucket
		}
		return grouped
	}

	/** Test helper — reset the singleton between suites. */
	clear(): void {
		this.resources.clear()
	}
}

/** The process-wide registry. */
export const registry = new ResourceRegistry()

/** Register a table as a Sprout resource. */
export function resource(
	table: PgTable,
	config: ResourceConfig = {},
): RegisteredResource {
	return registry.register(table, config)
}

export const sprout = { resource, registry }
