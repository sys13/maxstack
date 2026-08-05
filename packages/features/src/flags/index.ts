/**
 * Feature flags (task 54, promoted to a catalog bundle in issue #187) — the
 * runtime half of the spec's flag layer.
 *
 * The *declaration* and the evaluation rule live in `@maxstack/spec`
 * (`FlagSpec`, `evaluateFlag`, `flagGates`) so a flagged surface is visible in
 * the workbench without a database, and so the ownership generators — which
 * import the spec and nothing else — provably cannot reach an evaluation. They
 * are re-exported here so a consumer that thinks "flags" has one import rather
 * than needing to know which half of the feature lives where.
 *
 * What this package adds is everything that needs a database: coalesced usage
 * telemetry and the stale-flag report built on it.
 */

export {
	evaluateFlag,
	evaluateFlags,
	type FlagContext,
	type FlagGate,
	type FlagSpec,
	type FlagsSpec,
	type FlagTargeting,
	findFlag,
	flagGates,
	listFlags,
	MAX_ROLLOUT_PERCENT,
	rolloutBucket,
} from '@maxstack/spec'
export { FLAGS_DDL, flagEvaluation } from './schema.ts'
export {
	assertCanManageFlags,
	canManageFlags,
	FLAG_MANAGER_ROLES,
	type FlagActor,
	FlagPermissionError,
	FlagService,
	type FlagServiceOptions,
	type FlagUsage,
	type StaleFlagOptions,
	type StaleFlagReason,
	type StaleFlagRow,
} from './service.ts'
