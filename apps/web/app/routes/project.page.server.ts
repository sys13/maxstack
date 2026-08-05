/**
 * The list page's loader.
 *
 * Separate from the component because these four surfaces stopped being route
 * modules: the router mounts one splat that resolves what a path means and
 * delegates here. A route module gets its `loader` export stripped from the
 * client bundle; a plain module does not, so a loader left beside a component
 * would drag `~/sprout.server` and friends into the browser — which is a build
 * error, and would have been a data leak if it were not.
 */

import { listHandler } from '@maxstack/core'
import { data } from 'react-router'
import { inlineEditableFields } from '~/inline-edit'
import { liveQueryKeyFor, liveSlotFor } from '~/live.server'
import {
	type ProjectRouteArgs,
	projectChrome,
	resolveProjectResource,
} from '~/project.server'
import {
	demoSeedManifest,
	getContext,
	hasDemoData,
	resolveCapabilities,
	resolveRowFiles,
	resolveRowReferences,
} from '~/sprout.server'
import {
	anchorDay,
	tableColumns,
	viewLimit,
	viewListOptions,
} from './project.page'

/** The tracked demo ids for one resource, or `[]` when nothing was seeded. */
async function demoRowIds(resource: string): Promise<string[]> {
	const manifest = await demoSeedManifest()
	return manifest.rows[resource] ?? []
}

export async function loader({ request, params }: ProjectRouteArgs) {
	const resolved = await resolveProjectResource(params.page, request)
	const ctx = await getContext(request)
	// A date-arranged view reads the same rows through the same
	// handler as the list; only *which* rows and in what order differ, because
	// a calendar is a window on a date column rather than the first page of one.
	const view = resolved.page.view
	const anchor = anchorDay(request, view)
	const res = await listHandler(ctx, resolved.resource, {
		...(view
			? viewListOptions(view, anchor)
			: {
					limit: 100,
					orderBy: resolved.page.order?.field,
					orderDir: resolved.page.order?.direction,
				}),
	})
	if (res.status !== 200) throw data(res.body, { status: res.status })
	// Derived values — computed fields evaluated per row, rollups
	// aggregated in SQL — already rode out of `listHandler` on the op context.
	const rows = res.body as Record<string, unknown>[]
	const chrome = await projectChrome()
	return {
		page: resolved.page,
		nav: resolved.nav,
		title: chrome.title,
		theme: chrome.theme,
		// Sample-data notice — the frame renders it on every surface.
		demoRows: chrome.demoRows,
		primaryKey: resolved.primaryKey,
		columns: tableColumns(resolved.introspection, resolved.page.fields),
		rows,
		// What this session may do to this resource (task 22/35). The server
		// enforces it either way — `opUpdate` is the wall, not this — but a list
		// that offers an inline editor to a viewer whose every save will 403 is a
		// UI that lies. List-level, so an `owner` rule reads as denied here and is
		// re-checked per row on the write.
		can: await resolveCapabilities(ctx, resolved.resource),
		// The cells this list edits in place: declared by the block,
		// then narrowed to the columns that can actually be edited. Narrowed on the
		// server so the client never receives a name it is not allowed to write —
		// though the write itself is gated where every other write is.
		editable: inlineEditableFields(
			resolved.introspection.columns,
			resolved.page.editable,
		),
		// FK columns render the referenced record's title, not its raw id — the
		// same batched resolution the admin list uses.
		references: await resolveRowReferences(ctx, resolved.introspection, rows),
		files: resolveRowFiles(resolved.introspection, rows, ctx.user?.id ?? null),
		// Empty-state guidance (task 63 / issue #60): only offer "load demo data"
		// when a bundle actually has sample rows for this project.
		demoAvailable: rows.length === 0 ? await hasDemoData() : false,
		// Which of these rows are sample data. A seeded row is an
		// ordinary row — no marker column, by design — so the id set is the only
		// thing that can tell them apart, and it has to reach the list component.
		demoIds: resolved.page.resource
			? await demoRowIds(resolved.page.resource)
			: [],
		// The day the grid is drawn around, resolved on the server:
		// "today" is a question about the *declared* zone, and answering it in the
		// browser would hydrate a different grid than the one that was rendered.
		anchor,
		// Whether the row set hit the cap a timeline (or a multi-day calendar)
		// reads under — surfaced rather than silently swallowed, since a truncated
		// chart looks exactly like a complete one.
		truncated: view ? rows.length >= viewLimit(view) : false,
		// The declared live channel for this resource, if it has one.
		// This is what makes a derived list, board, calendar or timeline update
		// without a refresh: the surface subscribes when a key comes back and stays
		// a plain snapshot when it does not, so declaring a channel is opt-in
		// rather than a tax every page pays. A PAUSED channel still yields its key
		// — the client subscribes, is refused with a reason, and polls the same op
		// — which is what makes pausing safe rather than a silent stop.
		liveKey: resolved.page.resource
			? await liveQueryKeyFor(resolved.page.resource)
			: undefined,
		// The bespoke live surface this resource declared, if it declared one
		//. A `slot: true` query channel says the surface is genuinely
		// bespoke — a drag-and-drop board, a threaded reader — and the platform's
		// job is to hand the user's component the rows it already gates and
		// projects rather than to grow a vocabulary for drag targets. The generic
		// list, board and calendar keep regenerating right beside it for every
		// resource that did not.
		liveSlot: resolved.page.resource
			? await liveSlotFor(resolved.page.resource, 'query')
			: undefined,
	}
}
