/**
 * The review-cost pane — what approving a change actually costs the
 * maintainer, on the surface where they do the approving.
 *
 * Three deliberate choices about how this is presented, because a measurement's
 * presentation is where it usually starts lying:
 *
 *   1. **Every number says "engaged" and carries its idle cutoff.** A figure that
 *      can be quoted without its qualification will be, and "12 seconds to review
 *      a change" and "12 seconds of *attention* to review a change, counting gaps
 *      under two minutes" are different claims.
 *   2. **Elapsed sits in its own row with its own denominator**, never blended
 *      into the headline, and says how many decisions it could be computed for.
 *   3. **Off means absent, not zero.** A project that never opted in renders an
 *      explanation, not an empty chart with 0ms on it — which would read as
 *      "reviews are free" rather than "nobody measured".
 *
 * Entirely server-rendered: no state, no effects, no client-side clock. That is
 * partly restraint and partly issue #138 — a hydration mismatch on this surface
 * cannot be caught by a client-only `render()` test, so the safest amount of
 * client behaviour in a pane like this is none.
 */

import {
	describeReviewCost,
	formatDuration,
	type ReviewCostPoint,
	type ReviewCostSummary,
} from '@maxstack/core/review'
import type { ReviewCostView } from './review-cost.server'
import { paneClass } from './shared'

// ---------------------------------------------------------------------------
// The curve
// ---------------------------------------------------------------------------

const CHART_W = 260
const CHART_H = 56
const PAD = 4

/**
 * An inline SVG sparkline of cumulative engaged cost per proposal. Inline and
 * static for the same reason the harness dashboard's charts are: no library, no
 * request, no script — it renders in a terminal-adjacent context and in a saved
 * page identically.
 *
 * The *cumulative* series is plotted rather than the per-decision one. Review cost
 * is noisy per decision (one agonised-over proposal dominates), and the question
 * the curve answers is "is reviewing getting more expensive as the project grows",
 * which is a question about the trend, not the last point.
 */
function CostCurve({ curve }: { curve: readonly ReviewCostPoint[] }) {
	if (curve.length === 0) return null
	const values = curve.map((p) => p.cumulativeEngagedMsPerProposal)
	const max = Math.max(...values)
	const min = Math.min(...values)
	// A flat series would otherwise divide by zero and render nothing; pad it into
	// a visible horizontal line, which is the honest picture of "cost is stable".
	const span = max - min < 1 ? Math.max(max, 1) : max - min
	const floor = max - min < 1 ? 0 : min

	const x = (i: number) =>
		curve.length === 1
			? CHART_W / 2
			: PAD + (i / (curve.length - 1)) * (CHART_W - 2 * PAD)
	const y = (v: number) =>
		CHART_H - PAD - ((v - floor) / span) * (CHART_H - 2 * PAD)

	const points = values.map((v, i) => `${x(i)},${y(v)}`).join(' ')

	return (
		<svg
			viewBox={`0 0 ${CHART_W} ${CHART_H}`}
			className="my-1 w-full"
			role="img"
			aria-label={`Cumulative engaged review cost per proposal across ${curve.length} decisions, ending at ${formatDuration(values.at(-1) ?? 0)}`}
		>
			{curve.length === 1 ? (
				<circle cx={x(0)} cy={y(values[0] ?? 0)} r={2.5} fill="currentColor" />
			) : (
				<polyline
					points={points}
					fill="none"
					stroke="currentColor"
					strokeWidth={1.5}
					className="text-foreground/70"
				/>
			)}
			{/* Bulk decisions marked, so a visible drop can be attributed to the
			    thing that caused it rather than read as noise. */}
			{curve.map((p, i) =>
				p.mode === 'bulk' ? (
					<circle
						key={`${p.at}-${p.n}`}
						cx={x(i)}
						cy={y(values[i] ?? 0)}
						r={2}
						className="fill-primary"
					/>
				) : null,
			)}
		</svg>
	)
}

// ---------------------------------------------------------------------------
// The numbers
// ---------------------------------------------------------------------------

function Figures({ summary }: { summary: ReviewCostSummary }) {
	const { byMode } = summary
	return (
		<dl className="m-0 grid grid-cols-[auto_1fr] gap-x-2 gap-y-0.5 text-[0.75rem]">
			<dt className="text-muted-foreground">engaged / proposal</dt>
			<dd className="m-0 font-semibold">
				{formatDuration(summary.engagedMsPerProposal)}
				<span className="ml-1 font-normal text-muted-foreground">
					median {formatDuration(summary.medianEngagedMsPerProposal)}
				</span>
			</dd>

			<dt className="text-muted-foreground">proposals cleared</dt>
			<dd className="m-0">
				{summary.proposals} in {summary.decisions} decision
				{summary.decisions === 1 ? '' : 's'}
				{byMode.bulk > 0 ? (
					<span className="ml-1 text-muted-foreground">
						({byMode.bulk} in bulk · {byMode.individual} individually)
					</span>
				) : null}
			</dd>

			<dt className="text-muted-foreground">elapsed / decision</dt>
			<dd className="m-0">
				{summary.meanElapsedMs === null ? (
					<span className="text-muted-foreground">
						not knowable for any decision yet
					</span>
				) : (
					<>
						{formatDuration(summary.meanElapsedMs)}
						<span className="ml-1 text-muted-foreground">
							over {summary.elapsedKnown} of {summary.decisions} — wall clock,
							not attention
						</span>
					</>
				)}
			</dd>

			<dt className="text-muted-foreground">outcomes</dt>
			<dd className="m-0">
				{summary.byOutcome.accept} accepted · {summary.byOutcome.reject}{' '}
				rejected · {summary.byOutcome.resolve} resolved
			</dd>
		</dl>
	)
}

// ---------------------------------------------------------------------------
// The pane
// ---------------------------------------------------------------------------

export function ReviewCostPane({ cost }: { cost: ReviewCostView }) {
	if (!cost.enabled) {
		return (
			<section className={paneClass}>
				<h2 className="mt-0 text-base font-semibold">Review cost</h2>
				<p className="text-[0.82rem] text-muted-foreground">
					Not measured in this project. Review cost is the one number that says
					whether this surface is actually cheap to use — but it is telemetry
					about your own reviewing, so it is off unless you ask for it.
				</p>
				<p className="text-[0.78rem] text-muted-foreground">
					Turn it on with <code>"reviewMetrics": "local"</code> in{' '}
					<code>maxstack.json</code>, or{' '}
					<code>MAXSTACK_REVIEW_METRICS=local</code> for one session. Stays on
					this machine, in the same data dir as everything else.
				</p>
			</section>
		)
	}

	const { summary, curve } = cost.report
	return (
		<section className={paneClass}>
			<h2 className="mt-0 text-base font-semibold">Review cost</h2>
			{summary.proposals === 0 ? (
				<p className="text-[0.82rem] text-muted-foreground">
					{describeReviewCost(summary)} — accept or reject something and the
					curve starts here.
				</p>
			) : (
				<>
					<CostCurve curve={curve} />
					<Figures summary={summary} />
					<p className="mt-2 text-[0.7rem] text-muted-foreground">
						Engaged time counts gaps under{' '}
						{formatDuration(summary.idleCutoffMs)} as review; anything longer is
						treated as having walked away. It measures whether the{' '}
						<em>surface</em> is cheap, never whether you are fast.
					</p>
				</>
			)}
		</section>
	)
}
