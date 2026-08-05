/**
 * The workbench.
 *
 * # Organised around the app, not around the review machinery
 *
 * The previous layout was twelve peer panes down one page, in the order the
 * features happened to land: attention, spec tree, detail, structural queue,
 * ranked queue, decisions, bulk review, review cost, portals, flags, modules,
 * slots, drift. Every pane was individually defensible and the whole was not
 * usable — #256, from the person the tool is supposedly for: *"the organization
 * of information … is way too hard to understand what the hell is going on …
 * I feel like this thing is targeted to the developer of the maxstack
 * platform."*
 *
 * The rebuild keeps every fold and moves the furniture:
 *
 *   - **It opens on your intent.** `<IntentPane>` asks what you are trying to
 *     build and writes the answer into the product layer as a requirement, so an
 *     agent can read it out of the spec (`intent.server.ts`). Everything else on
 *     the page answers "what did my agent do while I was away", which is a real
 *     question and the second one.
 *   - **The spine is the app.** `<AppSpine>` lists this project's pages, data,
 *     pricing and flags, each carrying one number — how much under it is
 *     waiting on you. You navigate your app; review is an annotation on it,
 *     not a separate world with its own vocabulary.
 *   - **One main column** that is either the thing you clicked, or, when you
 *     have clicked nothing, the overview: what needs you, what is waiting for
 *     your OK, what you have been asked, and how to change something.
 *   - **Two named lists, not two things called "Review queue".** There were
 *     literally two panes with that heading — the structural inbox and the
 *     ranked issue list — which is most of why #256 reports "the review queue
 *     is zero I don't know". They are now "Waiting for your OK" and
 *     "Ideas & feedback".
 *   - **Everything else is behind one disclosure.** `<Diagnostics>` holds the
 *     eight introspection panes, closed by default. Nothing is deleted:
 *     several are the only browser-side view of a fold, and #198's rule is that
 *     the important things must not be terminal-only.
 *
 * The first pass deliberately left the loader loading all eight of those folds on
 * every request, on the grounds that collapsing a pane is a layout decision and
 * must not quietly become a "this surface can no longer answer that" decision.
 * They are now behind `?under-the-hood=1`, which is that decision taken rather
 * than avoided: the address says whether they are loaded, both states are a plain
 * server render, the open page is a link somebody can send, and the closed state
 * still names all eight. The cost is one navigation; the alternative was computing
 * ownership drift, portal exposure, the bundle catalog, the slot inventory, review
 * cost and telemetry on every page view in order to discard them.
 *
 * # Built out of `@maxstack/ui` ("dogfood the library")
 *
 * Previously ~674 lines of inline `style={{}}` with hardcoded hex
 * reimplementing, worse, what the convenience library already does. Every pane
 * that renders tabular review rows now goes through `<ResourceList>` +
 * `bulkActions`, filtering goes through `<FilterForm>`, and per-target audit
 * goes through `<History>` (previously an admin-only feature) — same tokenized
 * Tailwind (zinc CSS variables, see `app.css`) the deployed `/admin` uses, so
 * the workbench and the deployed admin finally read as one product.
 *
 * What ported cleanly: both review queues are genuinely tabular — a
 * synthetic `IntrospectedResource` (columns inferred are display-only, never
 * backed by a real Sprout table) is enough for `<ResourceList>` to render them
 * with zero hand-written cell JSX, and `<FilterForm>`'s facet inference
 * (enum dropdowns from `enumValues`, a range pair from a `number` column) needs
 * no bespoke filter UI either. The one off-surface gap: `<ResourceList>` has no
 * concept of "cascade a decision onto this row's undecided children" (the
 * structural queue's core semantic) — bulk selection assumes independent rows.
 * The structural queue below works around it by keeping cascade a per-row
 * action outside the selection model (`bulkActions` still fires plain
 * accept/reject over the current selection, which is correct for it — the
 * ranked queue's rows are independent, so no gap there). See the module note
 * on `StructuralQueuePane` for the specifics.
 *
 * That gap is now closed at the library, not worked around here: `<ResourceList>`
 * grew a `rowActions` slot, because a per-row control had nowhere to go
 * and both queues were rendering their buttons in a *detached list underneath
 * the table*, aligned with the rows by nothing but luck. Cascade still is not a
 * selection semantic — it is a row semantic, and rows now have a place to put
 * one.
 */

import {
	type FilterValues,
	filtersFromSearchParams,
	filtersToSearchParams,
} from '@maxstack/ui'
import { Link, useSearchParams } from 'react-router'
import { AgentHandoff } from '~/workbench/agent-handoff'
import { runAiClustering } from '~/workbench/ai-cluster.server'
import { AppSpine } from '~/workbench/app-spine'
import { loadWorkbenchAttention } from '~/workbench/attention.server'
import { AttentionPane } from '~/workbench/attention-pane'
import {
	submitBulkReview,
	submitBulkUndo,
} from '~/workbench/bulk-review.server'
import { BulkReviewPane } from '~/workbench/bulk-review-pane'
import {
	ActivityPane,
	DecisionsPane,
	DetailPane,
} from '~/workbench/detail-panes'
import { Diagnostics } from '~/workbench/diagnostics'
import { loadDiagnostics } from '~/workbench/diagnostics.server'
import { DiffPreviewPane } from '~/workbench/diff-pane'
import {
	type DiffPreviewData,
	loadDiffPreview,
} from '~/workbench/diff-preview.server'
import { DriftPane } from '~/workbench/drift-pane'
import { FlagsPane } from '~/workbench/flags-pane'
import { loadIntents, submitIntent } from '~/workbench/intent.server'
import { IntentPane } from '~/workbench/intent-pane'
import { landIssueCandidate } from '~/workbench/land.server'
import { ModulesPane } from '~/workbench/modules-pane'
import { PortalsPane } from '~/workbench/portals-pane'
import { RankedQueuePane, StructuralQueuePane } from '~/workbench/queue-panes'
import { ReviewCostPane } from '~/workbench/review-cost-pane'
import type { ReviewQueueModel } from '~/workbench/review-queue'
import {
	loadReviewQueue,
	parseQueueView,
	submitTriage,
} from '~/workbench/review-queue.server'
import { CountBar, diffHref } from '~/workbench/shared'
import { SlotsPane } from '~/workbench/slots-pane'
import {
	loadWorkbench,
	submitConfusionSignal,
	submitResolve,
	submitReview,
	type WorkbenchPageData,
} from '~/workbench/workbench.server'
import type { Route } from './+types/workbench'

export async function loader({ request }: Route.LoaderArgs) {
	const url = new URL(request.url)
	const focus = url.searchParams.get('focus')
	const queueView = parseQueueView(url.searchParams.get('queue'))
	const diffKey = url.searchParams.get('diff')
	// The eight introspection folds are behind `?under-the-hood=1`. They used to be
	// loaded on every request and rendered inside a closed `<details>` — eight
	// answers computed to hand back none of them. What the surface can answer is
	// unchanged; where it is, is now in the address, so the open page is still
	// shareable and still server-rendered. See `diagnostics.server.ts`.
	const underTheHood = url.searchParams.get('under-the-hood') === '1'
	const data = await loadWorkbench(focus)
	return {
		data,
		underTheHood,
		diagnostics: underTheHood ? await loadDiagnostics() : null,
		// What needs you, in order — the answer to "where do I start",
		// rendered above every pane rather than as a twelfth one. The ordering is
		// `attentionReport` in @maxstack/mcp, the same fold `maxstack review` and
		// the `workbench` MCP tool run, so no surface can disagree about what matters
		// most. Carries the derived blast radius and the public-exposure list, both of
		// which a spec diff under-describes.
		attention: await loadWorkbenchAttention(),
		// What you are trying to build, in your words, recorded into the product
		// layer — the frame the rest of the page hangs
		// off, so the surface opens on your intent rather than on the queue.
		intents: await loadIntents(),
		queue: await loadReviewQueue(queueView),
		diff: diffKey ? await loadDiffPreview(diffKey) : null,
	}
}

export async function action({ request }: Route.ActionArgs) {
	const form = await request.formData()
	const intent = form.get('intent')
	// The one write on this surface that is not about somebody else's proposal:
	// the maintainer saying what they are trying to build.
	// Lands as a product-layer requirement — see `intent.server.ts`.
	if (intent === 'record-intent')
		return { ok: true, intent: await submitIntent(form) }
	if (intent === 'resolve') await submitResolve(form)
	else if (intent === 'triage') await submitTriage(form)
	else if (intent === 'confusion-signal') await submitConfusionSignal(form)
	else if (intent === 'bulk-review')
		return { bulk: await submitBulkReview(form) }
	else if (intent === 'bulk-undo') return { undo: await submitBulkUndo(form) }
	else if (intent === 'cluster') {
		// The explicit Cluster step — never run implicitly (see
		// `ai-cluster.server.ts`'s module note). One maintainer click.
		const result = await runAiClustering()
		return { ok: !result.error, cluster: result }
	} else if (intent === 'land') {
		// The Land step — an accepted Issue's spec-op candidate routed
		// through `apply_spec_change`, gated to already-accepted issues only.
		const issueKey = String(form.get('issueKey') ?? '')
		const result = await landIssueCandidate(issueKey)
		return { ok: result.landed, land: result }
	} else await submitReview(form)
	return { ok: true }
}

// ---------------------------------------------------------------------------

export default function Workbench({ loaderData }: Route.ComponentProps) {
	const { attention, data, intents, queue, diff, underTheHood, diagnostics } =
		loaderData as {
			attention: Awaited<ReturnType<typeof loadWorkbenchAttention>>
			data: WorkbenchPageData
			intents: Awaited<ReturnType<typeof loadIntents>>
			queue: ReviewQueueModel
			diff: DiffPreviewData | null
			underTheHood: boolean
			diagnostics: Awaited<ReturnType<typeof loadDiagnostics>> | null
		}
	const [params, setParams] = useSearchParams()
	const focusId = params.get('focus')
	const diffKey = params.get('diff')

	const structuralFilters = filtersFromSearchParams(
		new URLSearchParams(
			Array.from(params.entries()).filter(([k]) => k.startsWith('sq.')),
		),
	)
	const rankedFilters = filtersFromSearchParams(
		new URLSearchParams(
			Array.from(params.entries())
				.filter(([k]) => k.startsWith('rq.'))
				.map(([k, v]) => [k.slice(3), v]),
		),
	)

	function setStructuralFilters(next: FilterValues) {
		const encoded = filtersToSearchParams(next)
		setParams(
			(prev) => {
				const out = new URLSearchParams(prev)
				for (const key of Array.from(out.keys()))
					if (key.startsWith('sq.')) out.delete(key)
				for (const [k, v] of Object.entries(encoded)) out.set(`sq.${k}`, v)
				return out
			},
			{ preventScrollReset: true },
		)
	}
	function setRankedFilters(next: FilterValues) {
		const encoded = filtersToSearchParams(next)
		setParams(
			(prev) => {
				const out = new URLSearchParams(prev)
				for (const key of Array.from(out.keys()))
					if (key.startsWith('rq.')) out.delete(key)
				for (const [k, v] of Object.entries(encoded)) out.set(`rq.${k}`, v)
				return out
			},
			{ preventScrollReset: true },
		)
	}

	// The app's own name, from the product layer of the tree — the rail and the
	// title are about *this* app, so a generic "Workbench" is not the headline.
	const appTitle =
		data.view.tree.find((layer) => layer.layer === 'product')?.label ??
		'Your app'

	return (
		<div className="mx-auto max-w-[90rem] p-6">
			<header className="mb-5">
				<div className="flex flex-wrap items-baseline gap-4">
					<h1 className="m-0 text-2xl font-semibold">{appTitle}</h1>
					<span className="text-[0.85rem] text-muted-foreground">
						workbench
					</span>
					<Link to="/admin" className="text-[0.85rem]">
						→ admin
					</Link>
				</div>
				<p className="mt-1 text-foreground/70">
					Decide what your agent proposed, and see what your app is made of.{' '}
					<CountBar counts={data.view.counts} />
				</p>
			</header>

			<div className="grid items-start gap-5 [grid-template-columns:minmax(0,0.8fr)_minmax(0,2.2fr)]">
				<AppSpine tree={data.view.tree} focusId={focusId} />

				{/* One main column: the thing you clicked, or — having clicked nothing
				    — the answer to "where do I start". */}
				<main className="min-w-0 space-y-5">
					{data.detail ? (
						<DetailPane
							detail={data.detail}
							history={data.history}
							preview={data.preview}
							previewNotes={data.previewNotes}
							previewHtml={data.previewHtml}
							previewError={data.previewError}
						/>
					) : (
						<>
							{/* Above even the attention report: your question, not the
							    machinery's. #198 orders what needs *you*; this asks what
							    you are here for, and it is the only pane that writes. */}
							<IntentPane view={intents} />
							{/* Then, in order: what needs you, never a bare
							    count. */}
							<AttentionPane attention={attention} />
							<AgentHandoff target={null} />
							<StructuralQueuePane
								queue={data.view.queue}
								filters={structuralFilters}
								onFilterChange={setStructuralFilters}
							/>
							<DecisionsPane view={data.view} />
						</>
					)}
				</main>
			</div>

			{/* Full width: wide tables belong out of the two-column grid. */}
			<div className="mt-5">
				<RankedQueuePane
					queue={queue}
					filters={rankedFilters}
					onFilterChange={setRankedFilters}
					params={params}
					activeDiffKey={diffKey}
				/>
			</div>

			{diff ? (
				<div className="mt-5">
					<DiffPreviewPane diff={diff} closeHref={diffHref(params, null)} />
				</div>
			) : null}

			{/* Closed by default, and now unloaded by default too: every one of these
			    is a real fold and none of them is what somebody building an app came
			    here for, so they cost a navigation instead of costing every request. */}
			<Diagnostics open={underTheHood} params={params}>
				{diagnostics ? (
					<>
						<BulkReviewPane bulk={diagnostics.bulk} />
						<PortalsPane
							portals={diagnostics.portals.portals}
							summary={diagnostics.portals.summary}
						/>
						<FlagsPane
							all={diagnostics.flags.all}
							stale={diagnostics.flags.stale}
						/>
						<ModulesPane modules={diagnostics.modules} />
						<SlotsPane inventory={diagnostics.slots} />
						<DriftPane report={diagnostics.drift} />
						<ReviewCostPane cost={diagnostics.cost} />
						<ActivityPane telemetry={diagnostics.telemetry} />
					</>
				) : null}
			</Diagnostics>
		</div>
	)
}
