/**
 * `@maxstack/core/review` — the review record and what it costs.
 *
 * Two pure modules, no I/O and no clock:
 *
 *   `events.ts`      the workbench interaction event and its JSONL codec — the
 *                    append-only record of what the maintainer did in the review
 *                    surface
 *   `review-cost.ts` the cost model over that record: engaged time separated from
 *                    elapsed, per *proposal* rather than per decision
 *
 * ## Why it lives here rather than in the workbench
 *
 * It started in `apps/web/app/workbench/`, next to the surface that produces the
 * events, which is where a reader would first look for it. It moved because of
 * and epic #167's gating line: **the workbench must never be the only
 * path** — everything reachable there has to be reachable through the CLI and MCP
 * too, and `packages/*` may not import `apps/*` (enforced by
 * `scripts/check-boundaries.mjs`). A cost model only the web app could evaluate
 * would have made "review cost" a number you can only see in a browser, which is
 * the wrong shape for a platform whose agent is a primary interface.
 *
 * `@maxstack/core` specifically because it is the widest reachable point: the MCP
 * tools, the feature bundles, the harness and every app can import it, and it has
 * no workspace dependencies of its own to drag along.
 *
 * The *hosts* stay where they belong — the JSONL append and the opt-in gate in
 * `apps/web/app/workbench/`, the CLI's file read in `apps/maxstack/`. Only the
 * pure fold is shared, which is the same split `store.ts`/`metrics.ts` already
 * uses in the harness.
 */

export * from './events.ts'
export * from './review-cost.ts'
