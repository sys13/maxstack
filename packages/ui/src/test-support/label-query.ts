/**
 * Test helper: match a `getByLabelText`/`queryByLabelText` query against a raw
 * field/column name (`firstName`) regardless of how the label is rendered on
 * screen (`First Name`, per `humanizeLabel`). Keeps test fixtures
 * readable (they can keep using the raw schema key) without hardcoding the
 * exact humanized string at every call site.
 */

import { humanizeLabel } from '../fields/field-semantics.ts'

function escapeRegExp(value: string): string {
	return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

/** Case-insensitive exact match against a raw field name's humanized label. */
export function byLabel(name: string): RegExp {
	return new RegExp(`^${escapeRegExp(humanizeLabel(name))}$`, 'i')
}
