/**
 * **Field projection for outbound payloads**.
 *
 * A webhook subscription is a standing instruction to send this app's data to a
 * URL somebody else controls. Sending the whole row is the easy default and the
 * wrong one: the moment an entity grows a `passwordResetToken`, an
 * `internalNotes`, or a customer's home address, every existing subscriber
 * silently starts receiving it. Nobody re-reviews a webhook they set up a year
 * ago.
 *
 * So a subscription declares which fields it receives, and the projection is
 * **default-deny**: a field nobody named is not sent. Adding a column to an
 * entity therefore cannot widen an existing subscription — the new field is
 * absent until a human names it, which is the review step that "send everything"
 * quietly skips.
 *
 * ## Why it lives here and not in a shared module yet
 *
 * Issue #185 asks to *reuse* the projection concept from #177 rather than invent
 * a second one. #177 has not landed, so there is nothing to reuse; this module
 * is written to be the thing it reuses, with the vocabulary (`fields`, `deny`,
 * `project`) chosen to match what a read-surface projection needs. When #177
 * lands it should import this rather than growing a parallel implementation —
 * and if the shapes turn out to differ, that is a decision to record, not to
 * discover by having two.
 */

/**
 * Keys that are never sent, whatever a subscription names.
 *
 * A blocklist on top of an allowlist looks redundant and is not: the allowlist
 * is authored by whoever created the subscription, and "let me name
 * `password_hash` and see what happens" is exactly the request this refuses.
 * Matching is on the normalized key, so `passwordHash`, `password_hash` and
 * `PasswordHash` are one rule.
 */
const NEVER_SENT = [
	'password',
	'passwordhash',
	'secret',
	'token',
	'tokenhash',
	'apikey',
	'accesstoken',
	'refreshtoken',
	'sessiontoken',
	'privatekey',
	'ssn',
	'taxid',
	'cardnumber',
	'cvv',
]

const normalize = (key: string): string =>
	key.toLowerCase().replace(/[_-]/g, '')

/** Whether `key` is one nothing may ever project. */
export function isNeverSent(key: string): boolean {
	const normalized = normalize(key)
	return NEVER_SENT.some(
		(banned) => normalized === banned || normalized.endsWith(banned),
	)
}

/** What one subscription receives for one resource. */
export interface FieldProjection {
	/** The resource this projection covers, e.g. `invoice`. */
	resource: string
	/**
	 * The fields to send. **Default-deny**: anything absent is not sent, so a new
	 * column cannot widen an existing subscription.
	 */
	fields: string[]
}

/** Reasons a declared projection is refused at subscribe time. */
export function projectionErrors(
	projections: readonly FieldProjection[],
): string[] {
	const errors: string[] = []
	const seen = new Set<string>()
	for (const projection of projections) {
		if (seen.has(projection.resource))
			errors.push(`duplicate projection for resource "${projection.resource}"`)
		seen.add(projection.resource)
		if (projection.fields.length === 0)
			errors.push(
				`projection for "${projection.resource}" names no fields — a subscription that receives nothing is a subscription nobody wanted`,
			)
		for (const field of projection.fields) {
			if (isNeverSent(field))
				errors.push(
					`projection for "${projection.resource}" names "${field}", which is never sent to a third party`,
				)
		}
	}
	return errors
}

/**
 * Project `data` for a subscription.
 *
 * `undefined` projections mean the subscription predates the projection feature.
 * Those get the **identifier-only** payload rather than the whole row: an
 * existing subscriber keeps working (it still learns that the event happened and
 * which row it was about) and stops receiving field data it was never
 * deliberately granted. A subscriber that needs fields declares them, which is
 * the review step.
 */
export function projectPayload(
	resource: string,
	data: unknown,
	projections: readonly FieldProjection[] | undefined,
): { data: Record<string, unknown>; projected: boolean } {
	if (data === null || typeof data !== 'object' || Array.isArray(data))
		return { data: {}, projected: false }
	const row = data as Record<string, unknown>
	const projection = projections?.find((p) => p.resource === resource)
	if (!projection) {
		// Identifier only. Not "everything" and not "nothing".
		const out: Record<string, unknown> = {}
		if ('id' in row) out.id = row.id
		return { data: out, projected: false }
	}
	const out: Record<string, unknown> = {}
	for (const field of projection.fields) {
		if (isNeverSent(field)) continue
		if (field in row) out[field] = row[field]
	}
	return { data: out, projected: true }
}
