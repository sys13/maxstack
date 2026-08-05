/**
 * `useRestore` (Plan v5 task 46) — restore a prior revision as a typed update
 * through task-33's `useUpdate`, so a restore optimistically patches the cache,
 * toasts, and reconciles exactly like any edit (it *is* an edit, back to an old
 * state). Strips server-owned fields (pk + timestamps) from the snapshot before
 * writing so the restore sets only the record's own data.
 */

import { useCallback } from 'react'
import type { RecordId } from '../data/data-provider.ts'
import { type MutationOptions, useUpdate } from '../data/hooks.ts'
import type { Row } from '../resource/resource-types.ts'
import type { Snapshot } from './diff.ts'

export interface UseRestoreOptions {
	idField?: string
	/** Fields never written on restore (default: pk + `createdAt`/`updatedAt`). */
	omit?: string[]
}

export function useRestore(resource: string, options: UseRestoreOptions = {}) {
	const idField = options.idField ?? 'id'
	const omit = new Set(options.omit ?? [idField, 'createdAt', 'updatedAt'])
	const [update, state] = useUpdate(resource, { idField })

	const restore = useCallback(
		(snapshot: Snapshot, mutationOptions?: MutationOptions<Row>) => {
			const id = snapshot.snapshot[idField] as RecordId
			const values: Row = {}
			for (const [k, v] of Object.entries(snapshot.snapshot)) {
				if (!omit.has(k)) values[k] = v
			}
			return update(id, values, {
				successMessage: 'Revision restored.',
				...mutationOptions,
			})
		},
		[update, idField, omit],
	)

	return [restore, state] as const
}
