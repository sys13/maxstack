/**
 * @maxstack/features — L5 feature bundles.
 *
 * A bundle = runtime (schema + relations + pages + templates + DB plugin +
 * DI bindings) + artifacts (PRD fragment, tech spec, tests, issue template)
 * + dependencies & policy (prerequisites, entitlement checks). Full bundling is
 * Phase 6; this package currently *stages* the mxscratchpad features (task 5),
 * each reimplemented on the canonical stack with the original's tests ported as
 * the acceptance gate. Reference specs live in `docs/reference-specs/`.
 *
 * Staged so far:
 *   - `auth`    — better-auth sessions + RBAC role (replaces the dev header).
 *   - `email`   — name-keyed template registry (custom overrides default).
 *   - `members` — org/member schema + `MemberService` (last-owner invariant).
 *   - `audit`   — db-agnostic audit sink (the reusable seam of `metrics.ts`).
 *   - `db-plugins` — seed-plugin registry with FK-ordered seed/clear.
 *   - `di`      — typed DI bindings contract + missing-binding guard.
 */

export const FEATURES_PACKAGE = '@maxstack/features' as const

export * as audit from './audit/index.ts'
export * as auth from './auth/index.ts'
export * as billing from './billing/index.ts'
export * as bundle from './bundle/index.ts'
export * as dbPlugins from './db-plugins/index.ts'
export * as di from './di/index.ts'
export * as documents from './documents/index.ts'
export * as email from './email/index.ts'
export * as members from './members/index.ts'
export * as metrics from './metrics/index.ts'
