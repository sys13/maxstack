/**
 * Access as spec-as-data — the **subject** axis of authorization.
 *
 * Every other access mechanism in this codebase describes the *object*: which
 * resource, which action, which field, which row. The vocabulary for the
 * *subject* has been four fixed strings — `'public' | 'authenticated' | 'admin'
 * | 'owner'` — with no way to declare a role, no way to name a group, and no
 * way to say "an action nobody granted is refused". This module is that missing
 * half, and nothing more: it declares **who** a rule can be about and **what
 * happens when no rule names them**.
 *
 * Four properties shape it, in the order they constrain the design:
 *
 * 1. **The declared half is the vocabulary; the bindings are rows.** A role is
 *    a *named grant set* — "which verbs expand to what" — and that is a shape,
 *    diffable and reviewable before an app exists. Who *holds* the role at 3am
 *    on a Tuesday is not a shape, it is data, and putting it in the spec would
 *    make every personnel change a spec commit. So {@link RoleSpec} and
 *    {@link GroupSpec} are declarations, and runtime membership is deliberately
 *    absent from this module — see the note on {@link AccessBinding} for the one
 *    exception the bootstrap forces.
 * 2. **Absence of a rule is a *declared* answer, not an accident.**
 *    {@link AccessSpec.default} is the whole point of the namespace existing.
 *    `'open'` is what every generated app does today and stays the default, so
 *    declaring a role changes nothing on its own; `'deny'` makes an ungoverned
 *    action refused, and is the setting the rest of this only matters for.
 * 3. **Grants only ever widen; they never narrow.** A role cannot take away
 *    what a resource's own `Access` rule allows. This is the same discipline
 *    api-key scopes and portals follow in the opposite direction (they only
 *    narrow, never grant), and for the same reason: a mechanism that can move a
 *    decision in both directions is a mechanism where the answer depends on
 *    evaluation order.
 * 4. **Nothing here reaches for an identity.** This module imports the spec's
 *    own ids and provenance and nothing else — no runtime, no store, no clock.
 *    That is not tidiness: the standing actors of an access system have to be
 *    resolvable at boot, and a bootstrap module that participates in an import
 *    cycle is a bootstrap that can be denied by the cycle. This codebase has
 *    already shipped that failure once, as a module-level const spreading a
 *    cross-package binding that died in its temporal dead zone.
 *
 * Enumerability, as everywhere else in the vocabulary: {@link roleGrants} and
 * {@link grantHolders} answer "what can this role do" and "who can do this"
 * without a code search, because an access system whose answers require grep is
 * an access system nobody audits.
 *
 * Deliberately **not** here, and each filed separately: a principal's whole
 * effective grant set and why each yes is held (#453), scoped authority to
 * administer grants, evaluating a proposed binding set against the fleet before
 * applying it, grants that expire (#451), refusals that name whose rule refused
 * (#450), and the read boundary's filter-silently/404-not-403 rule. Six verbs
 * that declare a role are the easy half; those are the half that decides whether
 * deny-by-default is survivable in an organisation rather than routed around.
 */

import type { AccessBindingId, GroupId, ISODate, RoleId } from './ids.ts'
import { getAcceptedOrAll, type Provenanced } from './provenance.ts'
import type { SpecSystem } from './spec-system.ts'

/**
 * What a grant is about. Identical to the runtime's `SproutAction` by intent and
 * restated here rather than imported, because the spec package may not depend on
 * the core runtime (see `ARCHITECTURE.md`) — and because a spec must be
 * meaningful with no runtime present at all. The two are kept in step by
 * `accessPolicyFromSpec`, which is the one place they meet.
 */
export type AccessAction = 'read' | 'create' | 'update' | 'delete'

/** Every action a grant may name, for validation and for the op catalog. */
export const ACCESS_ACTIONS: readonly AccessAction[] = [
	'read',
	'create',
	'update',
	'delete',
]

/**
 * What happens to an action **no rule governs**.
 *
 * `'open'` — allowed. What `permissions.ts` has always done, what every
 * generated app in existence relies on, and therefore the value a spec has when
 * it has never said otherwise.
 *
 * `'deny'` — refused unless some role the caller holds grants it. This is the
 * setting the namespace exists for; it is per-app and opt-in precisely because
 * flipping it globally would break every app already generated, and a migration
 * nobody can price is a migration nobody performs.
 */
export type AccessDefault = 'open' | 'deny'

/** The default a spec has before any `access.setDefault` lands. */
export const DEFAULT_ACCESS_DEFAULT: AccessDefault = 'open'

/**
 * A key for a role, a group, or the principal a binding names: lowercase,
 * digits, dashes. The same shape every other key in the vocabulary uses, for the
 * same reason — it survives being a URL segment, a column value, an env var
 * suffix and a log dimension without escaping.
 */
export const ACCESS_KEY_RE = /^[a-z][a-z0-9-]*$/

/** How many resources one role may name. A role that grants on more than this
 * is not a role, it is the absence of one wearing a label. */
export const MAX_ROLE_GRANTS = 200

/** One line of a role's grant set: a resource, and what the role may do to it.
 *
 * The resource is an entity *name* (`order`), not a branded {@link
 * import('./ids.ts').EntityId }, and that is deliberate: enforcement happens in
 * `permissions.ts` against a registered resource name, and a translation
 * performed at enforcement time would be a second place the projection could be
 * wrong. Same call `PortalIdentity` makes about column names. Existence of the
 * entity is still checked — at op time, by {@link roleGrantErrors}, where a
 * typo is cheap to fix.
 */
export interface RoleGrant {
	/** The entity name this line is about. */
	resource: string
	/** What the role may do to it. Empty is rejected — say `access.revoke`. */
	actions: AccessAction[]
}

/** A declared role: a named, reviewable grant set. */
export interface RoleSpec extends Provenanced {
	id: RoleId
	/**
	 * The stable key a binding names and an identity carries (`support`). Separate
	 * from {@link id} because this is the string that ends up in a session, in an
	 * audit line, and in every human conversation about who can do what — and
	 * because relabelling a role in prose must not move anybody's authority.
	 */
	key: string
	/** What the role is for, in one line. Rendered in the workbench, and quoted
	 * in the review where somebody decides whether to bind it. */
	description: string
	/** What holders may do. Widening only — a grant never removes an allowance
	 * the resource's own rule gives. Order is not significant. */
	grants: RoleGrant[]
	/**
	 * The day the role was declared (`YYYY-MM-DD`), stamped by `applyOp` from the
	 * op's `appliedAt` rather than authored. Role age is the first half of
	 * "is anybody still using this", exactly as it is for a flag, and a
	 * hand-written date is a date that lies.
	 */
	declaredAt: ISODate
}

/**
 * A declared group: a **named set whose membership is runtime data**.
 *
 * The declaration is the name and what it is for; the rows that say who is in it
 * are not here, and not in the spec at all. A group exists as a declaration so a
 * binding can name something more durable than a list of people — "the on-call
 * rotation" outlives everyone currently in it — and so the workbench can show a
 * binding that points at a group nobody has ever joined, which is the quiet way
 * an access model stops matching the organisation it describes.
 */
export interface GroupSpec extends Provenanced {
	id: GroupId
	/** The stable key a binding names (`on-call`). */
	key: string
	/** Who the group is meant to contain, in one line. */
	description: string
	declaredAt: ISODate
}

/** What a binding can point at. */
export type AccessPrincipalKind = 'group' | 'role'

/**
 * Who a binding is about. A `group` principal is the ordinary case. A `role`
 * principal composes roles — binding `admin` to `support` means every holder of
 * `admin` also holds everything `support` grants — which is how a tier expands
 * without restating its grants.
 *
 * There is deliberately **no `user` principal.** Naming a person in the spec
 * would put a personnel fact in a file that is diffed, reviewed and published,
 * and would make every leaver a spec commit. A person holds a role through a
 * row, which this layer does not own.
 */
export interface AccessPrincipal {
	kind: AccessPrincipalKind
	/** The declared group key or role key. */
	key: string
}

/**
 * A **bootstrap** binding: a standing grant that must hold before any row
 * exists.
 *
 * This is the one place a binding is a declaration rather than a row, and it is
 * confined to that one job. Deny-by-default has a chicken-and-egg problem —
 * somebody has to be able to administer the bindings, and under `'deny'` the
 * caller who would create the first binding is refused by the rule the binding
 * would satisfy. Declaring the standing actors resolves it at the only moment
 * that works: before anything runs.
 *
 * Ordinary "give Dana the support role on Tuesday" is a row and is not modelled
 * here. If bootstrap bindings start accumulating one per person, that is the
 * signal the runtime binding table is the missing piece, not that this list
 * should grow.
 */
export interface AccessBinding extends Provenanced {
	id: AccessBindingId
	/** The declared role being conferred. */
	role: string
	/** Who gets it. */
	principal: AccessPrincipal
	declaredAt: ISODate
}

/** The `access` namespace: the declared vocabulary and the default. */
export interface AccessSpec {
	/** What an ungoverned action does. See {@link AccessDefault}. */
	default: AccessDefault
	roles: RoleSpec[]
	groups: GroupSpec[]
	/** Standing bindings only — see {@link AccessBinding}. */
	bindings: AccessBinding[]
}

/**
 * The `access` namespace a spec has before any `access.*` op lands: nothing
 * declared, and the historical open default.
 *
 * A factory rather than a shared const, because the applier reaches for it to
 * seed a spec that is about to be written into — and a shared const would hand
 * every such spec the *same* three arrays. Every writer here happens to build a
 * new array rather than push into one, so a shared const would work today and
 * silently stop working the first time somebody writes the obvious `push`.
 */
export function emptyAccess(): AccessSpec {
	return {
		default: DEFAULT_ACCESS_DEFAULT,
		roles: [],
		groups: [],
		bindings: [],
	}
}

// ===========================================================================
// Reading a spec
// ===========================================================================

/**
 * The `access` namespace, or the empty one. Read sites go through this so
 * "absent" never leaks past the spec package — and so the answer to "what does
 * this app do with an ungoverned action" is always a value, never `undefined`.
 */
export function resolveAccess(spec: Pick<SpecSystem, 'access'>): AccessSpec {
	return spec.access ?? emptyAccess()
}

/** What an ungoverned action does in this spec. */
export function accessDefault(spec: Pick<SpecSystem, 'access'>): AccessDefault {
	return resolveAccess(spec).default
}

/** Every declared role, grounded or not. The ungrounded list is what a report
 * or the workbench wants — a rejected role is still declared. */
export function listRoles(spec: Pick<SpecSystem, 'access'>): RoleSpec[] {
	return resolveAccess(spec).roles
}

/** Every declared group, grounded or not. */
export function listGroups(spec: Pick<SpecSystem, 'access'>): GroupSpec[] {
	return resolveAccess(spec).groups
}

/** Every standing binding, grounded or not. */
export function listBindings(
	spec: Pick<SpecSystem, 'access'>,
): AccessBinding[] {
	return resolveAccess(spec).bindings
}

/** The declared role with this key, if any. */
export function findRole(
	spec: Pick<SpecSystem, 'access'>,
	key: string,
): RoleSpec | undefined {
	return listRoles(spec).find((r) => r.key === key)
}

/** The declared group with this key, if any. */
export function findGroup(
	spec: Pick<SpecSystem, 'access'>,
	key: string,
): GroupSpec | undefined {
	return listGroups(spec).find((g) => g.key === key)
}

/**
 * Expand a set of held role keys through `role`-principal bindings.
 *
 * Binding `admin` to `support` means an `admin` also holds everything `support`
 * grants. Expansion is transitive and **cycle-tolerant by construction**: the
 * visited set is the loop bound, so `a → b → a` terminates with `{a, b}` rather
 * than hanging. A cycle is still rejected at op time by
 * {@link bindingCycleErrors} — this function tolerates one because an evaluator
 * that hangs on bad data is worse than one that answers a defensible thing, and
 * because a spec can reach this code path from a hand-edited file that no op
 * ever validated.
 */
export function expandRoles(
	spec: Pick<SpecSystem, 'access'>,
	held: readonly string[],
): string[] {
	const bindings = getAcceptedOrAll(listBindings(spec))
	const seen = new Set<string>()
	const queue = [...held]
	while (queue.length > 0) {
		const key = queue.shift()
		if (key === undefined || seen.has(key)) continue
		seen.add(key)
		for (const binding of bindings)
			if (binding.principal.kind === 'role' && binding.principal.key === key)
				queue.push(binding.role)
	}
	return [...seen]
}

/**
 * The role keys conferred by membership in these groups — the bridge between
 * runtime membership and the declared vocabulary.
 *
 * An app knows which groups an identity is in (from its own rows, or from the
 * members bundle); this says what that membership *means*. The result is what
 * belongs on the identity's held-roles list, which is the only way a group
 * binding has any effect at runtime — the enforcement policy cannot flatten
 * group bindings, because it does not know who is in one.
 *
 * Grounded, like {@link grantHolders}: a binding nobody accepted confers
 * nothing. Role-to-role composition is applied on top, so a group bound to a
 * role that holds another role yields both.
 */
export function rolesForGroups(
	spec: Pick<SpecSystem, 'access'>,
	groups: readonly string[],
): string[] {
	const bindings = getAcceptedOrAll(listBindings(spec))
	const direct = bindings
		.filter(
			(b) => b.principal.kind === 'group' && groups.includes(b.principal.key),
		)
		.map((b) => b.role)
	return expandRoles(spec, direct)
}

/**
 * What one role may do: resource name → the actions it grants.
 *
 * The enumerability half of the module. "What can a member actually do" is the
 * question a permission matrix is built to answer, and today it can only be
 * answered by reading four hard-coded strings. Note the scope: this is one
 * role's *declared* grants, not a principal's effective set across every role
 * and binding they hold — that is #453, and it is a different, larger
 * computation that has to explain *why* each yes is held.
 */
export function roleGrants(
	spec: Pick<SpecSystem, 'access'>,
	key: string,
): Record<string, AccessAction[]> {
	const role = findRole(spec, key)
	if (!role) return {}
	const grants: Record<string, AccessAction[]> = {}
	for (const grant of role.grants) {
		const existing = grants[grant.resource] ?? []
		grants[grant.resource] = [
			...existing,
			...grant.actions.filter((a) => !existing.includes(a)),
		]
	}
	return grants
}

/**
 * Every declared role that grants `action` on `resource` — the inverse lookup,
 * and the one a reviewer actually asks: *who can delete an invoice?*
 *
 * Grounded, unlike {@link roleGrants}: a role somebody proposed and nobody
 * accepted confers nothing, so it must not appear in the answer to "who can do
 * this". The same accepted-else-all rule the data and page layers use.
 */
export function grantHolders(
	spec: Pick<SpecSystem, 'access'>,
	resource: string,
	action: AccessAction,
): RoleSpec[] {
	return getAcceptedOrAll(listRoles(spec)).filter((role) =>
		role.grants.some(
			(g) => g.resource === resource && g.actions.includes(action),
		),
	)
}

/**
 * One line describing a role, for a diff summary or a workbench row. Leads with
 * the grant count rather than the description, because the count is the part a
 * reviewer is checking and the prose is the part they already read.
 */
export function describeRole(role: Pick<RoleSpec, 'key' | 'grants'>): string {
	const resources = new Set(role.grants.map((g) => g.resource))
	const actions = new Set(role.grants.flatMap((g) => g.actions))
	if (resources.size === 0) return `${role.key} (grants nothing)`
	return (
		`${role.key} (${actions.size} action(s) on ${resources.size} resource(s): ` +
		`${[...resources].sort().join(', ')})`
	)
}

/** One line describing a binding, for a diff summary. */
export function describeBinding(
	binding: Pick<AccessBinding, 'role' | 'principal'>,
): string {
	return `${binding.principal.kind} "${binding.principal.key}" holds role "${binding.role}"`
}

// ===========================================================================
// Validation shared by the ops and the schema
// ===========================================================================

/**
 * Errors in a grant list. Shared by `access.defineRole` and `access.grant` so
 * the two cannot drift — the second is the incremental spelling of the first,
 * and a rule enforced on only one of them is a rule with a bypass.
 *
 * `resources` is the set of entity names that exist. Passing an empty set
 * disables the existence check, which is what the codec's decode path wants: a
 * spec dir is decoded file by file, and `access.json` must not fail to load
 * because `data.json` has not been read yet.
 */
export function roleGrantErrors(
	label: string,
	grants: readonly RoleGrant[] | undefined,
	resources: ReadonlySet<string>,
): string[] {
	const errors: string[] = []
	if (!grants) return errors
	if (grants.length > MAX_ROLE_GRANTS)
		errors.push(
			`${label}: ${grants.length} grants exceeds the ${MAX_ROLE_GRANTS} cap — a role that grants on everything is the absence of a role wearing a label`,
		)
	const seen = new Set<string>()
	for (const grant of grants) {
		if (typeof grant.resource !== 'string' || grant.resource.length === 0) {
			errors.push(`${label}: every grant needs a resource name`)
			continue
		}
		if (seen.has(grant.resource))
			errors.push(
				`${label}: duplicate grant on "${grant.resource}" — one line per resource, listing every action`,
			)
		seen.add(grant.resource)
		if (resources.size > 0 && !resources.has(grant.resource))
			errors.push(
				`${label}: unknown resource "${grant.resource}" — no entity by that name`,
			)
		if (!Array.isArray(grant.actions) || grant.actions.length === 0) {
			errors.push(
				`${label}: grant on "${grant.resource}" lists no actions — remove the line with access.revoke rather than granting nothing`,
			)
			continue
		}
		for (const action of grant.actions)
			if (!ACCESS_ACTIONS.includes(action))
				errors.push(
					`${label}: unknown action "${String(action)}" on "${grant.resource}" — one of ${ACCESS_ACTIONS.join(', ')}`,
				)
	}
	return errors
}

/**
 * Errors from role-principal binding cycles, given the bindings that *would*
 * exist. Reported at op time so a spec cannot be written into a state where
 * "which roles does an admin hold" is a question about traversal order.
 *
 * {@link expandRoles} tolerates a cycle rather than relying on this — the two
 * are belt and braces on purpose, because this check only runs on the op path
 * and a spec dir can be hand-edited.
 */
export function bindingCycleErrors(
	label: string,
	bindings: readonly Pick<AccessBinding, 'role' | 'principal'>[],
): string[] {
	const edges = new Map<string, string[]>()
	for (const binding of bindings) {
		if (binding.principal.kind !== 'role') continue
		// `principal` holds `role`, so authority flows principal → role.
		edges.set(binding.principal.key, [
			...(edges.get(binding.principal.key) ?? []),
			binding.role,
		])
	}
	const errors: string[] = []
	const state = new Map<string, 'visiting' | 'done'>()
	const walk = (key: string, path: string[]): void => {
		if (state.get(key) === 'done') return
		if (state.get(key) === 'visiting') {
			errors.push(
				`${label}: role binding cycle ${[...path, key].join(' → ')} — a role cannot, transitively, hold itself`,
			)
			return
		}
		state.set(key, 'visiting')
		for (const next of edges.get(key) ?? []) walk(next, [...path, key])
		state.set(key, 'done')
	}
	for (const key of edges.keys()) walk(key, [])
	return errors
}
