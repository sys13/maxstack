/**
 * The server half of a declared portal: find the plan, verify the
 * credential, build the narrowed identity, wire the write budget.
 *
 * **Nothing here decides what may be read.** Not a column list, not a row
 * filter, not an access check. Every one of those lives in the permission layer
 * and in the read/write ops (`portalGrants`, `projectForPortal`, the forced
 * bound), because issue #186's finding was that a route-level gate is a gate
 * `/mcp` and the admin loaders never pass. This module's whole job is to turn a
 * URL and a credential into a `SproutUser` and hand it to the ordinary ops.
 *
 * The consequence worth stating: if this file were deleted, nothing would become
 * *more* exposed. The portal routes would 404, and every other caller would
 * behave exactly as it does today.
 */

import { type OpContext, type PortalPlan, portalIdentity } from '@maxstack/core'
import {
	PORTAL_TOKENS_DDL,
	PortalTokenService,
} from '@maxstack/features/api-keys'
import {
	type RateLimiter,
	rateLimiterFromEnv,
} from '@maxstack/features/observability'
import { getCoordinator } from './coordination.server'
import { getAuditSink, getSprout, resolveUser } from './sprout.server'

const portalScope = globalThis as typeof globalThis & {
	__maxstackPortalTokensReady?: boolean
}

/**
 * The limiter every portal write spends from.
 *
 * Its window is an hour rather than the deployment default's minute, because a
 * portal's declared budget is stated per hour — see `PortalWrite.rateLimitPerHour`.
 * A token bucket refilling over an hour smooths a burst without letting a
 * comment form absorb a year's traffic in the first minute.
 *
 * **Shared across instances when the deployment has one to share** (
 * absorbing #227's first half). The buckets live in the coordinator, which is
 * Postgres when the store is Postgres and this process's memory when it is
 * pglite — where a second instance cannot exist. It used to be unconditionally
 * per-process, so two containers served each declared budget at twice its
 * declared number, silently.
 *
 * Built lazily, once: the coordinator needs the store backend, and reaching for
 * it at module load would put a database round trip in front of every route that
 * imports this file.
 */
const portalLimiterScope = globalThis as typeof globalThis & {
	__maxstackPortalLimiter?: Promise<RateLimiter>
}
function portalLimiter(): Promise<RateLimiter> {
	portalLimiterScope.__maxstackPortalLimiter ??= (async () => {
		const limiter = rateLimiterFromEnv(
			{ ...process.env, RATE_LIMIT_WINDOW_MS: String(3_600_000) },
			{ coordinator: await getCoordinator() },
		)
		console.info('[portals]', limiter.describe())
		return limiter
	})()
	return portalLimiterScope.__maxstackPortalLimiter
}

export async function getPortalTokenService(): Promise<PortalTokenService> {
	const { backend } = await getSprout()
	if (!portalScope.__maxstackPortalTokensReady) {
		await backend.exec(PORTAL_TOKENS_DDL)
		portalScope.__maxstackPortalTokensReady = true
	}
	return new PortalTokenService({ db: backend.db, audit: getAuditSink() })
}

/**
 * How many proxies sit in front of this deployment, per the operator.
 *
 * `MAXSTACK_TRUSTED_PROXY_HOPS`. Unset means "nobody has told us there is a
 * proxy", and that is treated as **there is not one** — see {@link clientIdOf}.
 */
function trustedProxyHops(): number {
	const raw = process.env.MAXSTACK_TRUSTED_PROXY_HOPS
	const n = raw === undefined ? 0 : Number.parseInt(raw, 10)
	return Number.isFinite(n) && n > 0 ? n : 0
}

/** Warned once per process, not per request — this is a deployment fact. */
let warnedAboutSpoofableHeader = false

/**
 * A coarse, stable identifier for an anonymous caller — the rate-limit bucket.
 *
 * # The header is attacker-controlled until an operator says otherwise
 *
 * This used to read `x-forwarded-for`'s **leftmost** entry unconditionally. That
 * entry is whatever the client sent: nothing in the platform verified a proxy had
 * overwritten it, and no proxy is required to. An attacker rotating the header
 * therefore minted an unbounded number of buckets, which is a rate limiter that
 * does not limit — the declared `rateLimitPerHour` was enforced per *made-up
 * identity*.
 *
 * So the trust is declared instead of assumed. `MAXSTACK_TRUSTED_PROXY_HOPS` is
 * the number of proxies the operator put in front of this deployment:
 *
 *   - **Unset (the default).** The header is ignored entirely and every anonymous
 *     caller shares one bucket. The portal's declared budget then means what it
 *     says — a cap on anonymous writes — rather than a cap per fabricated address.
 *   - **Set to N.** The entry N from the **right** is used: the address the
 *     outermost trusted hop actually observed. Everything to the left of it was
 *     supplied by the caller and is discarded. Reading the leftmost entry, which
 *     is what this did, is reading the one part an attacker fully controls.
 *
 * The default is deliberately the strict direction, and it costs something worth
 * naming: with one shared bucket, one abusive caller can exhaust the anonymous
 * budget for everyone. That is a bounded, declared failure an operator fixes with
 * one environment variable; the alternative is an unbounded one nobody can see.
 * Neither shape is a disclosure risk — the projection, the bound and the
 * per-request gate are unaffected, and a portal still cannot read or write
 * anything it did not declare.
 *
 * Still not an identity, and still not used for anything that grants access.
 */
export function clientIdOf(request: Request): string {
	const hops = trustedProxyHops()
	if (hops === 0) {
		if (!warnedAboutSpoofableHeader && request.headers.has('x-forwarded-for')) {
			warnedAboutSpoofableHeader = true
			console.warn(
				'[portals] x-forwarded-for is present but MAXSTACK_TRUSTED_PROXY_HOPS is ' +
					'unset, so it is being ignored: an unverified forwarding header is ' +
					'caller-controlled, and trusting it lets one caller mint unlimited ' +
					'rate-limit buckets. Anonymous portal writes share a single ' +
					'bucket until you set it to the number of proxies in front of this app.',
			)
		}
		return 'anonymous'
	}
	const chain =
		request.headers
			.get('x-forwarded-for')
			?.split(',')
			.map((part) => part.trim())
			.filter(Boolean) ?? []
	// Nth from the right: what the outermost hop we trust actually saw. A chain
	// shorter than the declared hop count means the request did not come through
	// the proxies we were told about, so there is nothing here worth trusting.
	const observed = chain.length >= hops ? chain[chain.length - hops] : undefined
	return (observed ?? request.headers.get('x-real-ip') ?? 'anonymous').trim()
}

export interface PortalRequest {
	ctx: OpContext
	plan: PortalPlan
}

/**
 * Resolve `/p/:key` into a context whose identity is the portal's, or `null`.
 *
 * `null` covers every reason a portal is not reachable — unknown key, paused,
 * missing or invalid token, wrong role — and the routes render one 404 for all
 * of them. Distinguishing them would tell a stranger which portal keys exist and
 * which tokens used to be valid, which is an oracle for free.
 *
 * The token arrives as `?t=`. A header would be tidier and is not an option: the
 * whole premise of a token portal is a link somebody can click.
 */
export async function portalRequest(
	request: Request,
	key: string,
): Promise<PortalRequest | null> {
	const { registry, store } = await getSprout()
	const found = registry.findPortal(key)
	if (!found) return null
	const { plan } = found

	let tokenId: string | undefined
	let rowId: string | undefined
	if (plan.audience === 'token') {
		const presented = new URL(request.url).searchParams.get('t')
		if (!presented) return null
		const service = await getPortalTokenService()
		const verified = await service.verify(presented)
		// Verified against the portal it was minted for: a token for the client
		// portal must not open the public archive's row-scoped sibling, and the
		// token itself is the only place that binding can live.
		if (!verified || verified.portalKey !== key) return null
		tokenId = verified.tokenId
		rowId = verified.rowId ?? undefined
	}

	const user = portalIdentity(plan, {
		clientId: clientIdOf(request),
		...(tokenId ? { tokenId } : {}),
		...(rowId ? { rowId } : {}),
		// Only a `role` portal consults it; `portalIdentity` ignores it otherwise.
		session: plan.audience === 'role' ? await resolveUser(request) : null,
	})
	if (!user) return null

	return {
		plan,
		ctx: {
			registry,
			store,
			user,
			audit: getAuditSink(),
			// The declared hourly budget is spent inside `opCreate`/`opUpdate`. A
			// context without this refuses portal writes outright rather than
			// allowing unbudgeted ones — see `OpRateLimiter`.
			rateLimit: async (bucket, perHour) =>
				(await (await portalLimiter()).check(bucket, perHour)).allowed,
		},
	}
}
