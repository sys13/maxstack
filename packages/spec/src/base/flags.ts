/**
 * Feature flags as spec-as-data — the declaration *and* the pure
 * evaluation rule, so a flagged surface is visible in the workbench instead of
 * hidden in application code.
 *
 * Three properties shape everything here, in the order they constrain the design:
 *
 * 1. **Generation may never read a flag's value.** A flag changes what the
 *    running app *shows*; it never changes what the generator *writes*. The
 *    declaration is spec data (diffable, reviewable, regenerated identically),
 *    and evaluation happens per request against a viewer — so the determinism
 *    invariant (§L4A) is preserved by construction rather than by discipline.
 *    `flagContextFromViewer`/{@link evaluateFlag} take a viewer; nothing in the
 *    ownership generators can reach them.
 * 2. **Targeting is an allowlist over a default-off flag.** Role, organization,
 *    and percentage are three ways of saying "also on for these subjects". A
 *    flag whose default is already `true` cannot be narrowed by targeting — the
 *    validator rejects that combination rather than letting a spec claim a
 *    rollout it does not have.
 * 3. **Percentage rollout is a stable hash, not stored state.** The same subject
 *    always lands in the same bucket for a given flag key, with no persistence
 *    layer and no per-customer drift. Ramping a rollout from 10% to 20% is
 *    strictly additive: everyone already on stays on.
 *
 * Staleness — the standard failure mode of every flag system — is addressed by
 * the flag being *enumerable*: {@link flagGates} says exactly which surfaces a
 * flag gates, so "this flag gates nothing" is a computed fact rather than a
 * thing someone has to remember. The `flags` bundle turns that plus last-use
 * telemetry into a report.
 */

import type { FlagId, ISODate } from './ids.ts'
import { getAcceptedOrAll, type Provenanced } from './provenance.ts'
import type { SpecSystem } from './spec-system.ts'

/**
 * Who a flag is *also* on for, beyond its default. Every key is an OR: a subject
 * matching any of them gets the flag. Empty/absent targeting means the default
 * decides for everyone.
 */
export interface FlagTargeting {
	/** Roles the flag is on for (matched against the viewer's role). */
	roles?: string[]
	/** Organization ids the flag is on for (matched against the viewer's org). */
	organizations?: string[]
	/**
	 * Percent of subjects bucketed on, 0–100 (integer), by a stable hash of
	 * `subject:key`. A viewer with no subject id is never bucketed on — an
	 * anonymous visitor has no stable identity to be consistent with.
	 */
	rolloutPercent?: number
}

/** A declared feature flag. */
export interface FlagSpec extends Provenanced {
	id: FlagId
	/**
	 * The stable evaluation key a gated surface names (`checkout-v2`). Separate
	 * from {@link id} because it is the string that appears in `PageSpec.flag`,
	 * in telemetry, and in every human conversation about the rollout.
	 */
	key: string
	/** What the flag turns on, in one line. Rendered in the workbench. */
	description: string
	/** The value when no targeting rule matches. */
	default: boolean
	/** Who else the flag is on for. Rejected when `default` is already true. */
	targeting?: FlagTargeting
	/**
	 * The day the flag was declared (`YYYY-MM-DD`), stamped by `applyOp` from the
	 * op's `appliedAt` rather than authored. Flag *age* is the first half of
	 * stale-flag reporting, and a hand-written date is a date that lies.
	 */
	declaredAt: ISODate
}

export interface FlagsSpec {
	flags: FlagSpec[]
}

/** The maximum a `rolloutPercent` may be. 100 is "on for every subject". */
export const MAX_ROLLOUT_PERCENT = 100

/** A flag key: lowercase, digits, and dashes — the shape that survives being a
 * URL segment, an env var suffix, and a telemetry dimension without escaping. */
export const FLAG_KEY_RE = /^[a-z][a-z0-9-]*$/

/**
 * What varies per evaluation: the viewer. Everything here is server-derived —
 * the role and org come from the session/permission layer, never from a header
 * or a query param a client can set, which is what keeps a flag from being a
 * client-side authorization bypass.
 */
export interface FlagContext {
	/** Stable per-subject id for percentage bucketing (usually the user id). */
	subject?: string | null
	role?: string | null
	organizationId?: string | null
}

/** FNV-1a — small, dependency-free, and stable across runs and processes
 * (unlike JS's unspecified `Object`/`Map` hashing or `Math.random`). */
function stableHash(input: string): number {
	let hash = 0x811c9dc5
	for (let i = 0; i < input.length; i++) {
		hash ^= input.charCodeAt(i)
		hash = Math.imul(hash, 0x01000193)
	}
	return hash >>> 0
}

/** The bucket (0–99) a subject falls into for a flag — stable per subject+key. */
export function rolloutBucket(subject: string, key: string): number {
	return stableHash(`${subject}:${key}`) % 100
}

/**
 * Resolve one flag for one viewer. Pure, total, and synchronous: no IO, no
 * clock, no randomness — the same (flag, context) pair always yields the same
 * answer, which is what makes a flagged surface testable at all.
 */
export function evaluateFlag(flag: FlagSpec, ctx: FlagContext = {}): boolean {
	if (flag.default) return true
	const targeting = flag.targeting
	if (!targeting) return false
	if (ctx.role && targeting.roles?.includes(ctx.role)) return true
	if (
		ctx.organizationId &&
		targeting.organizations?.includes(ctx.organizationId)
	)
		return true
	if (targeting.rolloutPercent !== undefined && ctx.subject)
		return rolloutBucket(ctx.subject, flag.key) < targeting.rolloutPercent
	return false
}

/** Every declared flag, or `[]` for a spec that has never declared one. */
export function listFlags(spec: Pick<SpecSystem, 'flags'>): FlagSpec[] {
	return spec.flags?.flags ?? []
}

/** The declared flag with this key, if any. */
export function findFlag(
	spec: Pick<SpecSystem, 'flags'>,
	key: string,
): FlagSpec | undefined {
	return listFlags(spec).find((f) => f.key === key)
}

/**
 * Evaluate every *grounded* flag for one viewer — what a route loader calls
 * once per request to seed both the server-side gating and the client payload.
 *
 * Grounding is the same accepted-else-all rule the data and page layers use
 * (`getAcceptedOrAll`): a flag an agent proposed but nobody accepted does not
 * turn a surface on. {@link listFlags} is the ungrounded list, which is what a
 * report or the workbench wants — a rejected flag is still declared, and still
 * worth telling someone about.
 */
export function evaluateFlags(
	spec: Pick<SpecSystem, 'flags'>,
	ctx: FlagContext = {},
): Record<string, boolean> {
	const resolved: Record<string, boolean> = {}
	for (const flag of getAcceptedOrAll(listFlags(spec)))
		resolved[flag.key] = evaluateFlag(flag, ctx)
	return resolved
}

/** One surface a flag gates. */
export interface FlagGate {
	kind: 'page' | 'block'
	/** The gated row's branded id. */
	id: string
	/** The page a gated block belongs to. */
	parentId?: string
	/** Human label for a report or a workbench row. */
	label: string
}

/**
 * Every surface gated by `key`. The enumerability requirement: a flag system
 * where "what does this gate?" needs a code search is a flag system whose stale
 * flags are never found.
 */
export function flagGates(
	spec: Pick<SpecSystem, 'pages'>,
	key: string,
): FlagGate[] {
	const gates: FlagGate[] = []
	for (const page of spec.pages.pages) {
		if (page.flag === key)
			gates.push({ kind: 'page', id: page.id, label: page.name })
		for (const block of page.blocks)
			if (block.flag === key)
				gates.push({
					kind: 'block',
					id: block.id,
					parentId: page.id,
					label: `${page.name} · ${block.type}`,
				})
	}
	return gates
}
