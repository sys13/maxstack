/**
 * Preference *definitions* — the typed declaration a settings UI is
 * derived from, in the same spirit as an entity's fields deriving a CRUD form.
 *
 * The point of declaring them is that nothing downstream has to be hand-built or
 * hand-maintained: the settings page renders from this list, the resolver knows
 * every key's type and default without a lookup table, an unknown key is a
 * refused write rather than a row nobody reads, and adding a preference is one
 * entry rather than a column, a form field, a loader, and an action.
 *
 * **Where these live, and why not in the spec.** Flags are spec data because a
 * flagged *surface* is invisible otherwise — the workbench has to know a page is
 * gated. A preference changes a value, not the shape of the app, so it needs no
 * spec layer to be legible, and giving it one would mean four more ops and a
 * codec change for no new visibility. The registry is therefore code-owned and
 * extensible at the composition root (`new PreferencesService({ definitions })`),
 * exactly like billing's `PLANS`.
 *
 * **Scopes.** A definition names the scopes it may be set at. A preference set
 * at both resolves user-over-organization, which is what makes "the org default
 * is digest email, but I turned mine off" expressible without a second concept.
 */

export type PreferenceScope = 'user' | 'organization'

export type PreferenceType = 'boolean' | 'string' | 'number' | 'enum'

export type PreferenceValue = boolean | string | number

export interface PreferenceOption {
	label: string
	value: string
}

export interface PreferenceDefinition {
	/** Stable slug, unique in the registry: `email-notifications`. */
	key: string
	/** Field label in the derived UI. */
	label: string
	/** One-line help text under the field. */
	description?: string
	type: PreferenceType
	/**
	 * Where this preference may be set. `['user','organization']` means the org
	 * value is the default for members who have not set their own; `['organization']`
	 * is an org-wide policy no member can override.
	 */
	scopes: PreferenceScope[]
	/** The value when neither scope has one stored. Must match `type`. */
	default: PreferenceValue
	/** Required for `type: 'enum'`, rejected otherwise. */
	options?: PreferenceOption[]
	/** Section heading in the derived UI; ungrouped entries fall under `General`. */
	group?: string
}

/** The group a definition renders under when it names none. */
export const DEFAULT_PREFERENCE_GROUP = 'General'

/**
 * The preferences every app gets. The three notification toggles were the
 * original hand-built settings form (task 55/56); they are now three
 * declarations, and the form that renders them is derived.
 */
export const BUILT_IN_PREFERENCES: readonly PreferenceDefinition[] = [
	{
		key: 'email-notifications',
		label: 'Email notifications',
		description: 'Send transactional and digest email to my address.',
		type: 'boolean',
		scopes: ['user', 'organization'],
		default: true,
		group: 'Notifications',
	},
	{
		key: 'in-app-notifications',
		label: 'In-app notifications',
		description: 'Show notifications in the inbox.',
		type: 'boolean',
		scopes: ['user', 'organization'],
		default: true,
		group: 'Notifications',
	},
	{
		key: 'product-updates',
		label: 'Product updates',
		description: 'Occasional email about new features. Not transactional.',
		type: 'boolean',
		scopes: ['user'],
		default: true,
		group: 'Notifications',
	},
] as const

/**
 * Problems with a set of definitions — checked once when a registry is built,
 * so a malformed declaration fails at composition rather than at render.
 */
export function definitionErrors(
	definitions: readonly PreferenceDefinition[],
): string[] {
	const errors: string[] = []
	const seen = new Set<string>()
	for (const def of definitions) {
		const at = `preference "${def.key}"`
		if (!/^[a-z][a-z0-9-]*$/.test(def.key))
			errors.push(`${at}: key must be a lowercase slug`)
		if (seen.has(def.key)) errors.push(`${at}: declared twice`)
		seen.add(def.key)
		if (!def.label.trim()) errors.push(`${at}: needs a label`)
		if (def.scopes.length === 0)
			errors.push(`${at}: names no scope — it could never be set`)
		if (def.type === 'enum') {
			if (!def.options?.length)
				errors.push(`${at}: an enum preference needs options`)
			else if (!def.options.some((o) => o.value === def.default))
				errors.push(
					`${at}: default "${String(def.default)}" is not one of its options`,
				)
		} else if (def.options) {
			errors.push(`${at}: options are only meaningful for an enum preference`)
		}
		if (!valueMatchesType(def.default, def.type))
			errors.push(
				`${at}: default ${JSON.stringify(def.default)} is not a ${def.type}`,
			)
	}
	return errors
}

/** Whether a stored or submitted value is the type its definition declares. */
export function valueMatchesType(
	value: unknown,
	type: PreferenceType,
): value is PreferenceValue {
	switch (type) {
		case 'boolean':
			return typeof value === 'boolean'
		case 'number':
			return typeof value === 'number' && Number.isFinite(value)
		case 'string':
		case 'enum':
			return typeof value === 'string'
	}
}

/**
 * Coerce one submitted value to its declared type, or `undefined` if it cannot
 * be. Exists because HTML forms submit strings and an unchecked checkbox
 * submits nothing at all — the derived form's action needs one place where
 * "on"/"true"/absent become a boolean, rather than that logic being retyped per
 * field.
 */
export function coercePreferenceValue(
	definition: PreferenceDefinition,
	raw: unknown,
): PreferenceValue | undefined {
	switch (definition.type) {
		case 'boolean': {
			if (typeof raw === 'boolean') return raw
			if (raw === undefined || raw === null) return false
			const text = String(raw).toLowerCase()
			if (['on', 'true', '1', 'yes'].includes(text)) return true
			if (['off', 'false', '0', 'no', ''].includes(text)) return false
			return undefined
		}
		case 'number': {
			const n = typeof raw === 'number' ? raw : Number(String(raw ?? '').trim())
			return Number.isFinite(n) ? n : undefined
		}
		case 'string':
			return raw === undefined || raw === null ? undefined : String(raw)
		case 'enum': {
			const text = raw === undefined || raw === null ? '' : String(raw)
			return definition.options?.some((o) => o.value === text)
				? text
				: undefined
		}
	}
}
