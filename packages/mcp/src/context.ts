/**
 * The L3 platform-tools context — the analogue of Sprout's {@link OpContext}
 * for the *platform* half of the MCP surface.
 *
 * Sprout's per-resource CRUD tools run against a live database
 * (`OpContext = registry + store + user`). The platform tools instead drive the
 * project's **spec system** and its build machinery, so their context is:
 *
 *   - a {@link SpecStore}      — load/persist the one `SpecSystem`;
 *   - a {@link GeneratorRunner} — the code generators (`docs`, `e2e-tests`, …);
 *   - a {@link CheckRunner}     — the validate gate (spec-validate, typecheck,
 *                                 lint, tests);
 *   - `origin`/`now`/`nextOpId` — provenance + determinism seams (injected so
 *     the tools stay pure and testable; wall-clock/uuid in production, fixed in
 *     tests).
 *
 * Everything the tools touch is behind an interface so the same tool code runs
 * over an in-memory store in tests and over the real project on disk in the CLI
 * / web server, exactly as Sprout's `SproutStore` abstracts pglite vs Postgres.
 */

import type {
	ISODate,
	OpActor,
	OpId,
	RiskContext,
	SpecSystem,
} from '@maxstack/spec'
import type { AttentionInputs } from './attention.ts'

// ===========================================================================
// Spec store
// ===========================================================================

/** Load/persist the project's single {@link SpecSystem}. */
export interface SpecStore {
	load(): Promise<SpecSystem>
	save(next: SpecSystem): Promise<void>
}

// ===========================================================================
// Generators
// ===========================================================================

/** A generated file — a project-relative path and its contents. */
export interface GeneratedArtifact {
	path: string
	content: string
}

export interface GeneratorInfo {
	name: string
	summary: string
}

export interface GeneratorResult {
	generator: string
	artifacts: GeneratedArtifact[]
	notes: string[]
}

/** A generator is a (mostly) pure function of the spec → artifacts. */
export type Generator = (
	spec: SpecSystem,
	args: Record<string, unknown>,
) => GeneratorResult | Promise<GeneratorResult>

export interface RegisteredGenerator extends GeneratorInfo {
	run: Generator
}

export interface GeneratorRunner {
	list(): GeneratorInfo[]
	run(
		name: string,
		spec: SpecSystem,
		args: Record<string, unknown>,
	): Promise<GeneratorResult>
}

// ===========================================================================
// Checks — the validate gate
// ===========================================================================

export interface CheckInfo {
	name: string
	summary: string
}

export interface CheckResult {
	name: string
	ok: boolean
	output: string
}

/**
 * A check this host knows it *should* run and cannot.
 *
 * The distinction between "ran and passed" and "never ran" is the whole point.
 * An agent treats `ok: true` as terminal — it stops looking — so a check that
 * was silently omitted reads exactly like a check that passed, and a green over
 * unexamined code is worse than a red, because a red gets fixed. Anything this
 * host cannot execute is therefore *named*, with the reason and the remedy,
 * never dropped from the list.
 */
export interface UnavailableCheck {
	name: string
	/** Why it could not run here, concretely. */
	reason: string
	/** What would make it runnable — the message has to be actionable. */
	remedy?: string
	/**
	 * Whether this check not running withholds the green. Defaults to `true`, and
	 * `true` is the only honest answer whenever the check would have examined
	 * something that exists.
	 *
	 * `false` is for the narrow case where the check has nothing to examine yet —
	 * a project at op zero owns no code, so "typecheck never ran" describes an
	 * empty set and reporting it as incomplete makes the scaffold fail its own
	 * gate on creation, with no action available that would have prevented it.
	 * Such a check is still NAMED (that is why this is a flag and not an
	 * omission): the caller sees it, sees why it did not apply, and sees it turn
	 * blocking the moment there is owned code for it to look at.
	 */
	blocking?: boolean
}

/** A check is a function of the spec → pass/fail with captured output. */
export type Check = (spec: SpecSystem) => CheckResult | Promise<CheckResult>

export interface RegisteredCheck extends CheckInfo {
	run: Check
}

export interface CheckRunner {
	list(): CheckInfo[]
	/** Run the named checks (or all of them when `names` is omitted). */
	run(spec: SpecSystem, names?: string[]): Promise<CheckResult[]>
	/**
	 * Checks this host knows about but cannot execute.
	 *
	 * A runner that omits this is asserting it can run everything it knows about —
	 * which is true of the pure built-ins and false of any host that expects a
	 * project's own `typecheck` / `lint` / `test` commands to exist.
	 */
	unavailable?(): UnavailableCheck[] | Promise<UnavailableCheck[]>
}

// ===========================================================================
// The context
// ===========================================================================

/** The platform-tools context — L3's analogue of Sprout's `OpContext`. */
export interface PlatformContext {
	spec: SpecStore
	generators: GeneratorRunner
	checks: CheckRunner
	/** Who is driving — stamped onto applied ops + recorded decisions. */
	origin: 'ai' | 'human'
	/**
	 * *Which* author is driving — the agent that named itself, the
	 * session grouping this conversation's ops, the api key that authorized them.
	 * Host-supplied because only the host knows: this layer sees a JSON-RPC frame,
	 * not the process that sent it.
	 *
	 * `surface` and `path` are filled in by the tools themselves (they know which
	 * tool they are), so a host only has to answer the parts it actually knows —
	 * and a host that knows nothing supplies nothing rather than a placeholder.
	 */
	actor?: Pick<OpActor, 'agent' | 'session' | 'keyId'>
	/** Current date; deterministic in tests, wall-clock in production. */
	now: () => ISODate
	/** Fresh op ids; deterministic in tests. */
	nextOpId: () => OpId
	/**
	 * Catalog discovery + install preview, when the host can supply it.
	 *
	 * Wired by hosts rather than imported here on purpose. The bundle catalog
	 * lives in `@maxstack/features`, and `@maxstack/mcp` deliberately does not
	 * depend on it (`scripts/boundaries.config.json`): MCP is the *protocol*
	 * layer, and a protocol layer that knows the feature catalog is a protocol
	 * layer that has to be rebuilt every time the catalog moves. So the host —
	 * which already has both — supplies a provider, and the tool is present only
	 * where it can actually answer.
	 *
	 * Both methods return the values `describeCatalog()` / `previewInstall()`
	 * already produce, passed through to the agent as JSON. Restating their
	 * shapes here would be a second definition to keep in step, which is the
	 * drift the single-derivation rule exists to avoid.
	 */
	catalog?: CatalogProvider
	/**
	 * The ownership drift report, when the host has a filesystem.
	 *
	 * Wired by hosts rather than computed here, for the same reason
	 * {@link PlatformContext.catalog} is: drift is a **disk** fact — which files
	 * the manifest marks as yours, and what is in them — and this layer has only
	 * a spec store. A protocol layer that reached for `node:fs` to answer it would
	 * be a protocol layer that cannot run in the browser-side workbench, which is
	 * one of the three surfaces this has to serve.
	 *
	 * Returns the value `ownershipDrift()` already produces, passed through as
	 * JSON. Restating its shape here would be a second definition to keep in step.
	 */
	ownership?: OwnershipProvider
	/**
	 * Review cost, when the host can answer it.
	 *
	 * Host-supplied for the same reason {@link PlatformContext.ownership} is: the
	 * report is derived from an event log on disk and gated on a project config
	 * file, and this layer has only a spec store. Present only where it can
	 * actually be answered, so an agent that sees the tool knows a real answer
	 * exists behind it.
	 */
	reviewCost?: ReviewCostProvider
	/**
	 * The disk facts the ordered what-needs-you report consults.
	 *
	 * One seam rather than four, because the report's honesty rule is per-category:
	 * whatever a host cannot answer is named in `unavailable` and the headline
	 * refuses to claim an all-clear. A host wires what it can see and the report
	 * stays truthful about the rest — which is why this is optional and why its
	 * absence is safe.
	 */
	attention?: AttentionProvider
	/**
	 * How far the *built application* is behind the spec, for the steering pair
	 * every tool result carries (`steering.ts`).
	 *
	 * Host-supplied on the same terms as {@link PlatformContext.ownership}: the
	 * watermark lives in the route manifest on disk, and this layer has a spec
	 * store. Absence is load-bearing rather than a default — a host that cannot
	 * see the build produces no staleness warning at all, instead of a reassuring
	 * one it has no grounds for.
	 */
	generation?: GenerationProvider
	/**
	 * Where a reported defect is captured, when the host has
	 * somewhere to put one.
	 *
	 * Optional, but `report_defect` is listed and routable either way — unlike
	 * the other host-gated tools, and deliberately. The tool exists because an
	 * agent routes an observation into whatever write-shaped vocabulary is within
	 * reach: with no defect tool, a framework bug got written into the append-only
	 * decision ledger as a resolved architectural choice. A tool that is absent
	 * does not produce silence, it produces misfiling — so with no sink wired the
	 * call still succeeds and hands back a filled-in report, saying plainly that
	 * nothing was persisted.
	 */
	defects?: DefectSink
}

/** See {@link PlatformContext.defects}. */
export interface DefectSink {
	/**
	 * Persist one report. Returns where it landed, for the caller to be told.
	 */
	record(report: DefectReport): string | Promise<string>
}

/** One defect, as the reporting agent saw it. */
export interface DefectReport {
	title: string
	/** Which part of the platform misbehaved. */
	surface: string
	severity: string
	/** What was being done — enough to reproduce. */
	what: string
	expected: string
	actual: string
	workaround?: string
	reportedAt: string
	origin: 'ai' | 'human'
}

/** See {@link PlatformContext.generation}. */
export interface GenerationProvider {
	/** Op-log length the app was last generated from; `null` = never generated. */
	watermark(): number | null | Promise<number | null>
}

/** See {@link PlatformContext.attention}. */
export interface AttentionProvider {
	/** Drift, upgrades and ownership, as far as this host can see them. */
	inputs(): AttentionInputs | Promise<AttentionInputs>
}

/** See {@link PlatformContext.reviewCost}. */
export interface ReviewCostProvider {
	/**
	 * What approving a change costs the maintainer, or `null` when the project has
	 * not opted in.
	 *
	 * `null` rather than a zeroed report, and the distinction is the whole point:
	 * an agent reading a zero would conclude review is free, when what happened is
	 * that nobody measured. Absent is the honest answer.
	 *
	 * Returns the value `costReview()` already produces. Restating its shape here
	 * would be a second definition to keep in step.
	 */
	report(): unknown | Promise<unknown>
}

/** See {@link PlatformContext.ownership}. */
export interface OwnershipProvider {
	/** What the user owns, what it derives from, and how far it has drifted. */
	drift(): unknown | Promise<unknown>
	/**
	 * The ownership facts the review-risk model consults, when the
	 * host can supply them.
	 *
	 * Optional, and its absence is safe *because of how the risk model reads it*:
	 * these fields only ever **raise** risk, so an absent context is the most
	 * permissive input, not the safest one. The model therefore treats a context
	 * with no `ownershipKnown` flag as "assume everything is owned" and refuses to
	 * batch — which is what a host without this method gets.
	 *
	 * It hangs off the ownership provider rather than being a fourth top-level one
	 * because it is a projection of the same disk fact — `riskContextFromOwnership`
	 * derives it from the very manifest `drift()` reads. Unlike `drift()`, the
	 * return type is named: `RiskContext` is a **spec** type owned by the risk
	 * model, so typing it here is using one definition, not restating a disk shape.
	 */
	riskContext?(): RiskContext | Promise<RiskContext>
}

/** See {@link PlatformContext.catalog}. */
export interface CatalogProvider {
	/** The user-facing catalog, annotated with what this project has installed. */
	list(): unknown[] | Promise<unknown[]>
	/** What installing `slugs` would do — ops, diffs, prerequisites, refusals. */
	preview(slugs: string[]): unknown | Promise<unknown>
}
