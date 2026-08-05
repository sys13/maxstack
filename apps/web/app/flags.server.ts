/**
 * Owned-code wiring for the flag layer.
 *
 * Three jobs, and the split between them is the point:
 *
 *   - **The declaration is the spec's.** Nothing here decides what a flag is or
 *     who it is on for; `evaluateFlag` in `@maxstack/spec` does, from data the
 *     workbench can render and `maxstack validate` can check.
 *   - **The viewer is the server's.** {@link resolveViewerFlags} builds the
 *     evaluation context from the resolved identity — user id, role, active org
 *     — and from nothing a client can set. A flag routinely gates an unreleased
 *     surface, so "send a header to see it" would defeat the whole feature.
 *   - **The telemetry is coalesced.** `FlagService` accumulates counters in
 *     memory and writes once a minute, so gating a page costs no query on the
 *     read path and one write per flag per minute on the telemetry path.
 */

import {
	assertCanManageFlags,
	FLAGS_DDL,
	type FlagActor,
	FlagService,
	type StaleFlagRow,
} from '@maxstack/features/flags'
import type { SpecSystem } from '@maxstack/spec'
import { getPlatform, getSprout, resolveUser } from './sprout.server'

const flagScope = globalThis as typeof globalThis & {
	__maxstackFlagsReady?: boolean
	__maxstackFlagService?: FlagService
}

/**
 * The process-wide flag service. Deliberately a singleton: its whole value is
 * the in-memory counter it accumulates between flushes, which a per-request
 * instance would throw away — turning "one write a minute" back into "one write
 * a request", the trap the coalescing exists to avoid.
 */
export async function getFlagService(): Promise<FlagService> {
	const { backend } = await getSprout()
	if (!flagScope.__maxstackFlagsReady) {
		await backend.exec(FLAGS_DDL)
		flagScope.__maxstackFlagsReady = true
	}
	flagScope.__maxstackFlagService ??= new FlagService({ db: backend.db })
	return flagScope.__maxstackFlagService
}

/**
 * Every declared flag evaluated for the request's viewer, recording the use.
 *
 * Pass the spec when the caller has already loaded it (every project route
 * has), so a page render costs one spec load rather than two.
 */
export async function resolveViewerFlags(
	request: Request,
	spec?: SpecSystem,
): Promise<Record<string, boolean>> {
	const resolved = spec ?? (await getPlatform().spec.load())
	// No declared flags is the overwhelmingly common case: skip the service
	// entirely so an app that has never declared one never touches the table.
	if (!resolved.flags?.flags.length) return {}
	const [service, user] = await Promise.all([
		getFlagService(),
		resolveUser(request),
	])
	return service.evaluate(resolved, {
		subject: user?.id ?? null,
		role: user?.role ?? null,
		organizationId: user?.orgId ?? null,
	})
}

/**
 * The stale-flag report — every declared flag with its age, what it gates, and
 * when it was last evaluated, plus the subset that has a reason to be retired.
 * Rendered in the workbench; `flags.remove` is the op that acts on it.
 */
export async function flagReport(): Promise<{
	all: StaleFlagRow[]
	stale: StaleFlagRow[]
}> {
	const spec = await getPlatform().spec.load()
	if (!spec.flags?.flags.length) return { all: [], stale: [] }
	const service = await getFlagService()
	return service.report(spec)
}

/**
 * Refuse a flag-management action the request's identity may not perform.
 *
 * Applied at the service boundary rather than in a route, because routes are
 * not the only way in: the same authorization has to hold for the
 * MCP surface and any owned loader that lands a `flags.setTargeting` op.
 */
export async function requireFlagManager(request: Request): Promise<FlagActor> {
	const user = await resolveUser(request)
	const actor: FlagActor | null = user
		? { id: user.id, role: user.role ?? null }
		: null
	assertCanManageFlags(actor)
	// `assertCanManageFlags` throws on null, so this is a narrowing, not a cast.
	return actor as FlagActor
}
