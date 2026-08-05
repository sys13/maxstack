/**
 * `PreferencesService` (task 55, generalized in issue #187) — resolve, write,
 * and describe typed per-user and per-organization settings.
 *
 * Three requirements from #187 shape it:
 *
 * 1. **Typed, derived from declarations.** Every read and write is checked
 *    against a {@link PreferenceDefinition}: an unknown key is refused, a value
 *    of the wrong type is refused, and the settings UI is *derived* from the
 *    same list rather than hand-built beside it ({@link PreferencesService.describe}).
 * 2. **Reads must be cheap.** "A per-request settings lookup on every page is a
 *    performance trap" — so a resolve is at most one query per scope, and
 *    normally zero: values are cached per scope with a short TTL and
 *    invalidated on write.
 * 3. **RBAC on organization-level changes.** A member may set their own
 *    preferences and nobody else's; changing an organization's defaults is an
 *    owner/admin action. Both checks live *here*, at the service, not at a
 *    route — issue #186's lesson: routes are not the only way in.
 *
 * Resolution order is user → organization → declared default, and only for keys
 * whose definition names the scope. That order is what makes an org default
 * meaningful: a stored user row means the user chose, and an absent one means
 * they have not — a distinction the old column-per-preference table could not
 * express, since every column always had a value.
 */

import { and, eq, inArray } from 'drizzle-orm'
import type { drizzle } from 'drizzle-orm/pglite'
import {
	BUILT_IN_PREFERENCES,
	coercePreferenceValue,
	DEFAULT_PREFERENCE_GROUP,
	definitionErrors,
	type PreferenceDefinition,
	type PreferenceScope,
	type PreferenceValue,
	valueMatchesType,
} from './definitions.ts'
import { organizationPreference, userPreference } from './schema.ts'

type Db = ReturnType<typeof drizzle>

/** Who a write is performed by. */
export interface PreferenceActor {
	id: string
	role?: string | null
}

/** Roles that may change an organization's preference defaults. */
export const ORG_PREFERENCE_MANAGER_ROLES = ['owner', 'admin'] as const

export class PreferencePermissionError extends Error {
	constructor(message: string) {
		super(message)
		this.name = 'PreferencePermissionError'
	}
}

export class UnknownPreferenceError extends Error {
	constructor(key: string) {
		super(`Unknown preference "${key}"`)
		this.name = 'UnknownPreferenceError'
	}
}

/** Whether `actor` may change organization-wide preference defaults. */
export function canManageOrgPreferences(
	actor: PreferenceActor | null | undefined,
): boolean {
	const role = actor?.role
	return (
		!!actor &&
		!!role &&
		(ORG_PREFERENCE_MANAGER_ROLES as readonly string[]).includes(role)
	)
}

/**
 * Where a resolved value came from. Rendered in the UI as "from your
 * organization", so a member can tell an inherited value from their own choice.
 */
export type PreferenceSource = 'user' | 'organization' | 'default'

export interface ResolvedPreference {
	key: string
	value: PreferenceValue
	source: PreferenceSource
}

/** A resolved set, with typed accessors so callers do not re-narrow by hand. */
export class ResolvedPreferences {
	private readonly entries: Map<string, ResolvedPreference>

	constructor(entries: ResolvedPreference[]) {
		this.entries = new Map(entries.map((e) => [e.key, e]))
	}

	get(key: string): PreferenceValue | undefined {
		return this.entries.get(key)?.value
	}

	/** A boolean preference's value; `false` for an unknown or non-boolean key —
	 * the same "an absent gate is off" posture the flag layer takes. */
	bool(key: string): boolean {
		const value = this.get(key)
		return typeof value === 'boolean' ? value : false
	}

	string(key: string, fallback = ''): string {
		const value = this.get(key)
		return typeof value === 'string' ? value : fallback
	}

	number(key: string, fallback = 0): number {
		const value = this.get(key)
		return typeof value === 'number' ? value : fallback
	}

	source(key: string): PreferenceSource | undefined {
		return this.entries.get(key)?.source
	}

	all(): ResolvedPreference[] {
		return [...this.entries.values()]
	}

	/** Plain key → value, for a loader payload. */
	toJSON(): Record<string, PreferenceValue> {
		return Object.fromEntries([...this.entries].map(([k, e]) => [k, e.value]))
	}
}

/** One field of the derived settings UI. */
export interface PreferenceFieldView {
	key: string
	label: string
	description?: string
	type: PreferenceDefinition['type']
	options?: PreferenceDefinition['options']
	group: string
	value: PreferenceValue
	source: PreferenceSource
	/** Whether the form rendering this scope may write the field at all. */
	editable: boolean
}

/** The derived settings UI: fields grouped exactly as declared. */
export interface PreferenceGroupView {
	group: string
	fields: PreferenceFieldView[]
}

export interface PreferencesServiceOptions {
	db: Db
	/** Declarations to serve. Defaults to {@link BUILT_IN_PREFERENCES}. */
	definitions?: readonly PreferenceDefinition[]
	/**
	 * How long a resolved scope stays cached. Default 30s — long enough that a
	 * burst of page loads costs one query, short enough that a change made in
	 * another process appears without a restart. Set 0 to disable.
	 */
	cacheTtlMs?: number
	now?: () => Date
}

interface CacheEntry {
	values: Map<string, PreferenceValue>
	expiresAt: number
}

export class PreferencesService {
	private readonly db: Db
	private readonly definitions: readonly PreferenceDefinition[]
	private readonly byKey: Map<string, PreferenceDefinition>
	private readonly cacheTtlMs: number
	private readonly now: () => Date
	/** Cache key is `user:<id>` / `org:<id>`: the two scopes cache separately, so
	 * an org-wide change invalidates one entry rather than every member's. */
	private readonly cache = new Map<string, CacheEntry>()
	/** Queries issued since construction — the read-cost claim, observable. */
	private queries = 0

	constructor(opts: PreferencesServiceOptions) {
		this.db = opts.db
		this.definitions = opts.definitions ?? BUILT_IN_PREFERENCES
		const errors = definitionErrors(this.definitions)
		if (errors.length)
			throw new Error(
				`Invalid preference definitions:\n- ${errors.join('\n- ')}`,
			)
		this.byKey = new Map(this.definitions.map((d) => [d.key, d]))
		this.cacheTtlMs = opts.cacheTtlMs ?? 30_000
		this.now = opts.now ?? (() => new Date())
	}

	/** Every declaration this service serves, in declaration order. */
	list(): readonly PreferenceDefinition[] {
		return this.definitions
	}

	definition(key: string): PreferenceDefinition | undefined {
		return this.byKey.get(key)
	}

	/** How many preference queries have been issued. Exposed so the cheap-read
	 * requirement is a test assertion rather than a claim in a comment. */
	queryCount(): number {
		return this.queries
	}

	/**
	 * Resolve every declared preference for a user, an organization, or both.
	 *
	 * Cost: at most one query per scope, and none at all on a cache hit — the
	 * common case, since a page load resolves the same user more than once and a
	 * burst of loads falls inside the TTL.
	 */
	async resolve(target: {
		userId?: string | null
		organizationId?: string | null
	}): Promise<ResolvedPreferences> {
		const empty = new Map<string, PreferenceValue>()
		const [userValues, orgValues] = await Promise.all([
			target.userId ? this.scopeValues('user', target.userId) : empty,
			target.organizationId
				? this.scopeValues('organization', target.organizationId)
				: empty,
		])

		return new ResolvedPreferences(
			this.definitions.map((def) => {
				if (def.scopes.includes('user')) {
					const own = userValues.get(def.key)
					if (own !== undefined)
						return { key: def.key, value: own, source: 'user' as const }
				}
				if (def.scopes.includes('organization')) {
					const inherited = orgValues.get(def.key)
					if (inherited !== undefined)
						return {
							key: def.key,
							value: inherited,
							source: 'organization' as const,
						}
				}
				return { key: def.key, value: def.default, source: 'default' as const }
			}),
		)
	}

	/**
	 * The derived settings UI for one scope: every field a form should render,
	 * with its current value, where that value came from, and whether this scope
	 * may write it. The settings page renders this — it does not know the keys.
	 */
	async describe(
		scope: PreferenceScope,
		target: { userId?: string | null; organizationId?: string | null },
		actor?: PreferenceActor | null,
	): Promise<PreferenceGroupView[]> {
		const resolved = await this.resolve(target)
		const editable =
			scope === 'organization' ? canManageOrgPreferences(actor) : true
		const groups = new Map<string, PreferenceFieldView[]>()
		for (const def of this.definitions) {
			if (!def.scopes.includes(scope)) continue
			const group = def.group ?? DEFAULT_PREFERENCE_GROUP
			const field: PreferenceFieldView = {
				key: def.key,
				label: def.label,
				...(def.description ? { description: def.description } : {}),
				type: def.type,
				...(def.options ? { options: def.options } : {}),
				group,
				value: resolved.get(def.key) ?? def.default,
				source: resolved.source(def.key) ?? 'default',
				editable,
			}
			groups.set(group, [...(groups.get(group) ?? []), field])
		}
		return [...groups].map(([group, fields]) => ({ group, fields }))
	}

	/**
	 * Write one or more of a user's own preferences.
	 *
	 * `actor` must be the user themself. There is deliberately no "an admin edits
	 * your preferences" path: an admin who can flip another person's notification
	 * settings can silence their alerts, and the organization default is the
	 * supported way to steer members.
	 */
	async setUserPreferences(
		actor: PreferenceActor,
		userId: string,
		values: Record<string, unknown>,
	): Promise<ResolvedPreferences> {
		if (actor.id !== userId)
			throw new PreferencePermissionError(
				'A user’s preferences can only be changed by that user',
			)
		for (const [key, value] of this.validate('user', values)) {
			await this.db
				.insert(userPreference)
				.values({ userId, key, value, updatedAt: this.now() })
				.onConflictDoUpdate({
					target: [userPreference.userId, userPreference.key],
					set: { value, updatedAt: this.now() },
				})
		}
		this.cache.delete(`user:${userId}`)
		return this.resolve({ userId })
	}

	/**
	 * Write an organization's preference defaults — owner/admin only, checked
	 * here so every caller is covered rather than every route remembering.
	 */
	async setOrganizationPreferences(
		actor: PreferenceActor | null | undefined,
		organizationId: string,
		values: Record<string, unknown>,
	): Promise<ResolvedPreferences> {
		if (!canManageOrgPreferences(actor))
			throw new PreferencePermissionError(
				'Changing organization preferences requires an owner or admin',
			)
		for (const [key, value] of this.validate('organization', values)) {
			await this.db
				.insert(organizationPreference)
				.values({ organizationId, key, value, updatedAt: this.now() })
				.onConflictDoUpdate({
					target: [
						organizationPreference.organizationId,
						organizationPreference.key,
					],
					set: { value, updatedAt: this.now() },
				})
		}
		this.cache.delete(`org:${organizationId}`)
		return this.resolve({ organizationId })
	}

	/**
	 * Clear a user's own value for a key so it falls back to the organization
	 * default (or the declared one) — the operation "use the org default again",
	 * which writing a value cannot express.
	 */
	async clearUserPreference(
		actor: PreferenceActor,
		userId: string,
		key: string,
	): Promise<ResolvedPreferences> {
		if (actor.id !== userId)
			throw new PreferencePermissionError(
				'A user’s preferences can only be changed by that user',
			)
		if (!this.byKey.has(key)) throw new UnknownPreferenceError(key)
		await this.db
			.delete(userPreference)
			.where(
				and(eq(userPreference.userId, userId), eq(userPreference.key, key)),
			)
		this.queries++
		this.cache.delete(`user:${userId}`)
		return this.resolve({ userId })
	}

	/** Drop cached values — for a test, or after an out-of-band write. */
	invalidate(target?: {
		userId?: string | null
		organizationId?: string | null
	}): void {
		if (!target) {
			this.cache.clear()
			return
		}
		if (target.userId) this.cache.delete(`user:${target.userId}`)
		if (target.organizationId) this.cache.delete(`org:${target.organizationId}`)
	}

	/**
	 * Coerce and check a submitted map against the declarations, returning the
	 * writable entries. An unknown key is refused rather than stored: a typo'd
	 * preference that writes successfully and then reads back as its default is
	 * the most confusing failure this layer can have.
	 */
	private validate(
		scope: PreferenceScope,
		values: Record<string, unknown>,
	): [string, PreferenceValue][] {
		const entries: [string, PreferenceValue][] = []
		for (const [key, raw] of Object.entries(values)) {
			const def = this.byKey.get(key)
			if (!def) throw new UnknownPreferenceError(key)
			if (!def.scopes.includes(scope))
				throw new PreferencePermissionError(
					`Preference "${key}" cannot be set at the ${scope} level`,
				)
			const value = coercePreferenceValue(def, raw)
			if (value === undefined || !valueMatchesType(value, def.type))
				throw new TypeError(
					`Preference "${key}" expects a ${def.type}, got ${JSON.stringify(raw)}`,
				)
			entries.push([key, value])
		}
		return entries
	}

	/** Stored values for one scope, cached. */
	private async scopeValues(
		scope: PreferenceScope,
		id: string,
	): Promise<Map<string, PreferenceValue>> {
		const cacheKey = `${scope === 'user' ? 'user' : 'org'}:${id}`
		const nowMs = this.now().getTime()
		const cached = this.cache.get(cacheKey)
		if (cached && cached.expiresAt > nowMs) return cached.values

		const keys = this.definitions
			.filter((d) => d.scopes.includes(scope))
			.map((d) => d.key)
		const values = new Map<string, PreferenceValue>()
		if (keys.length > 0) {
			// One query per scope, bounded by the declared keys — a row for a
			// preference that no longer exists is never even fetched.
			this.queries++
			const rows =
				scope === 'user'
					? await this.db
							.select()
							.from(userPreference)
							.where(
								and(
									eq(userPreference.userId, id),
									inArray(userPreference.key, keys),
								),
							)
					: await this.db
							.select()
							.from(organizationPreference)
							.where(
								and(
									eq(organizationPreference.organizationId, id),
									inArray(organizationPreference.key, keys),
								),
							)
			for (const row of rows) {
				const def = this.byKey.get(row.key)
				// A stored value whose type no longer matches its declaration (someone
				// changed the type under it) is dropped rather than coerced: falling
				// back to the declared default is predictable, a coercion is not.
				if (def && valueMatchesType(row.value, def.type))
					values.set(row.key, row.value as PreferenceValue)
			}
		}
		if (this.cacheTtlMs > 0)
			this.cache.set(cacheKey, { values, expiresAt: nowMs + this.cacheTtlMs })
		return values
	}
}
