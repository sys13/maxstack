/**
 * The workbench interaction event and its JSONL codec — re-exported from
 * `@maxstack/core/review`, where it now lives.
 *
 * It moved out of this directory in issue #201. The event type is the input to the
 * review-cost model, and that model has to be evaluable from the CLI and MCP as
 * well as the browser, epic #167: the workbench must never be the only
 * path) — which means it cannot live in an app, because `packages/*` may not
 * import `apps/*`.
 *
 * This shim exists so the six modules in this directory that already import
 * `./telemetry` keep working and keep reading naturally: inside the workbench, the
 * event log is a workbench concept, and having every local consumer reach for a
 * package path would make the shared thing look like the foreign thing.
 * `telemetry.server.ts` — the JSONL append, which needs a filesystem and a clock —
 * stays here, because that half genuinely is the workbench's.
 */

export type {
	WorkbenchEvent,
	WorkbenchEventKind,
} from '@maxstack/core/review'
export {
	parseEvents,
	recentEvents,
	serializeEvent,
	serializeEvents,
	summarizeEvents,
	type TelemetrySummary,
} from '@maxstack/core/review'
