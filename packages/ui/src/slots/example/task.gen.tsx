/**
 * GENERATED page (example) — mirrors the shape `emitResourcePage` produces in
 * `@maxstack/core` (only the import specifiers differ: relative here so they
 * resolve inside this package's own test, `@maxstack/ui` in a real project).
 * Framework-owned; regeneration overwrites it. The `<Slot>` composes the
 * user-owned `task.slots.tsx` without this file importing anything the user
 * wrote by value — it only names the slot.
 *
 * Since #349 the emitted page is the *materialized* one: it takes the loader's
 * output as `OwnedRouteProps` and renders the declared list from it, so an
 * ejected module is the page rather than a heading over a comment. This fixture
 * tracks that shape, because its whole job is to be what the generator writes.
 */

import type { OwnedRouteProps } from '../../resource/owned-route.ts'
import { ResourceList } from '../../resource/ResourceList.tsx'
import { Slot } from '../Slot.tsx'
import * as slots from './task.slots.tsx'

export const meta = { resource: 'task', generated: true }

export default function TaskListPage({ list, newHref, Link }: OwnedRouteProps) {
	return (
		<section data-resource="task">
			<header className="mb-4 flex items-center justify-between">
				<h1 className="text-2xl font-semibold">Tasks</h1>
				<Link
					to={newHref}
					className="inline-flex h-9 items-center rounded-md bg-primary px-4 text-sm font-medium text-primary-foreground no-underline shadow transition-colors hover:bg-primary/90"
				>
					+ New
				</Link>
			</header>
			<ResourceList {...list} />
			<Slot name="afterList" render={slots.afterList} />
		</section>
	)
}
