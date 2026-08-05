/**
 * The `ExampleApp` shape — an eval app the harness runs the full pipeline
 * against. A example is a validated
 * {@link SpecSystem} (product + data + page layers, pages carrying
 * natural-language `e2eTests`) plus a **change set**: the sequence of change
 * requests the harness lands to measure the two gating numbers — the
 * change-expressibility ratio and the regeneration-safety pass rate (§6).
 *
 * The example set is deliberately biased toward **long-lived apps under
 * sustained change** (the maintainer ICP), so the change set — not the initial
 * generation — is where the signal lives (risk #7).
 */

import type { PageId, SpecOp, SpecSystem } from '@maxstack/spec'

/**
 * The off-surface clusters enumerated in epic #163 — the roadmap the corpus
 * scored. Each maps to the L2 child issue that must absorb it.
 *
 * It lives here rather than in `baseline.ts` because a *live* off-surface ask
 * now declares its own cluster: the breadth invariant used to read
 * clusters only from the frozen baseline, which meant a newly added hardening
 * ask could not contribute to breadth at all and the measure could only ever
 * fall. See `examples.test.ts`.
 */
export type OffSurfaceCluster =
	| 'rollup'
	| 'calendar'
	| 'board'
	| 'scheduling'
	| 'external-data'
	| 'public-surface'
	| 'realtime'
	| 'search'
	| 'import'
	| 'document-gen'
	| 'bespoke-ui'

/**
 * One change request against a generated example app. `kind` classifies it
 * for the change-expressibility ratio (§6): a **spec op** is the cheapest and
 * the moat's target (≥80%); a **slot fill** is a user edit absorbed by a
 * cross-file slot; an **eject** is the escape hatch that pays the eject tax; an
 * **off-surface** change is a product ask the platform has *no* op and *no*
 * slot to express — risk #1's bulk-archive class "and worse". It is what makes
 * the expressibility ratio a number that can actually move: a example whose
 * real backlog is full of off-surface asks scores a low spec-op share, exactly
 * as it should.
 */
export type ExampleChange = { id: string; description: string } & (
	| {
			/** A change expressed as a typed, additive spec op (e.g. `page.addPage`). */
			kind: 'spec-op'
			via: 'apply-op'
			op: SpecOp
	  }
	| {
			/** A page-level spec edit landed through regeneration-as-diff (bet B). */
			kind: 'spec-op'
			via: 'regen-diff'
			edit: { resource: string; title: string }
	  }
	| {
			/** A user edit absorbed by a cross-file extension slot — no eject. */
			kind: 'slot-fill'
			resource: string
			slot: string
			body: string
	  }
	| {
			/** Take whole-file ownership; the file stops receiving regen. */
			kind: 'eject'
			resource: string
	  }
	| {
			/**
			 * An ask with no typed op and no declared slot to express it — the moat
			 * gap. `resolution` records how it actually resolved: `eject` = the
			 * maintainer was *forced* off the surface and took whole-file ownership to
			 * land it by hand (mechanically an eject, but not a chosen one); it lands.
			 * `unexpressible` = the platform genuinely cannot land it — it does NOT
			 * reach the tree (an honest expressibility failure, not a regen-safety
			 * violation). Either way it counts against the spec-op share.
			 */
			kind: 'off-surface'
			resource: string
			resolution: 'eject' | 'unexpressible'
			/**
			 * The #163 cluster this ask belongs to. Required in practice for an ask
			 * added *after* the freeze — a frozen ask's cluster is read from
			 * `baseline.ts`, and one added later has no frozen entry to read it from,
			 * so without this it would be invisible to the breadth invariant.
			 */
			cluster?: OffSurfaceCluster
	  }
)

export interface ExampleApp {
	/** Stable id, e.g. `taskly`. */
	id: string
	/** Human label. */
	title: string
	/** The full three-layer spec the pipeline generates from. */
	spec: SpecSystem
	/** The change requests the harness lands, in order. */
	changes: ExampleChange[]
}

/** Re-exported for example authors so they need one import. */
export type { PageId, SpecOp, SpecSystem }
