/**
 * Shared "find this user's rows on an arbitrary resource" logic:
 * export and erasure both need it, so it lives once here instead of twice.
 *
 * Reuses the exact owner-column convention `owner` access rules already use
 * (`OWNER_FIELDS`) — a resource opts into GDPR export/erasure
 * for free the moment it has a `userId`/`authorId`/`owner`/`ownerId` column,
 * no extra config. A resource with none of those columns (no per-row owner —
 * e.g. a global `tag` table) is silently skipped: there's no way to know
 * which rows are "this user's".
 */

import type { RegisteredResource } from '@maxstack/core'
import { OWNER_FIELDS } from '@maxstack/core'

/** The owner column for `entry`, or `null` if it has none of the conventional
 * names. First match wins, same priority order `owner` access checks use. */
export function ownerFieldOf(entry: RegisteredResource): string | null {
	const names = new Set(entry.resource.columns.map((c) => c.name))
	for (const field of OWNER_FIELDS) {
		if (names.has(field)) return field
	}
	return null
}
