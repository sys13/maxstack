/**
 * GENERATED page (example) — mirrors the shape `emitResourcePage` produces in
 * `@maxstack/core` (only the `Slot` import specifier differs: relative here so
 * it resolves inside this package's own test, `@maxstack/ui` in a real
 * project). Framework-owned; regeneration overwrites it. The `<Slot>` composes
 * the user-owned `task.slots.tsx` without this file importing anything the user
 * wrote by value — it only names the slot.
 */

import { Slot } from '../Slot.tsx'
import * as slots from './task.slots.tsx'

export const meta = { resource: 'task', generated: true }

export default function TaskListPage() {
	return (
		<section data-resource="task">
			<h1>Tasks</h1>
			{/* generated resource list renders here */}
			<Slot name="afterList" render={slots.afterList} />
		</section>
	)
}
