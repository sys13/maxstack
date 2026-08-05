// ---------------------------------------------------------------------------
// Structural review queue (top-level entity/page/tier, cascade accept/reject)
// ---------------------------------------------------------------------------

import {
	FilterForm,
	type FilterValues,
	type IntrospectedResource,
	ResourceList,
	type Row,
	searchableFields,
} from '@maxstack/ui'
import { useMemo } from 'react'
import { Form, Link } from 'react-router'
import type { QueueItem, ReviewQueueModel } from './review-queue'
import {
	actionClass,
	diffHref,
	focusHref,
	paneClass,
	ReviewButtons,
	StatChip,
	StateChip,
	ViewExplainer,
	ViewToggle,
} from './shared'
import type { QueueRow } from './view-model'

/**
 * The provenance states, in the reader's words rather than the model's.
 *
 * `<FilterForm>` builds its dropdown from `meta.options` when present and falls
 * back to the bare `enumValues` otherwise — which is how a filter offering
 * "suggested / accepted / rejected / manual" ended up on a surface whose reader
 * has no reason to know that `manual` means "a human wrote this directly, so
 * there was never a suggestion to accept".
 */
const STATE_OPTIONS = [
	{ value: 'suggested', label: 'Waiting for you' },
	{ value: 'accepted', label: 'In your app' },
	{ value: 'rejected', label: 'Turned down' },
	{ value: 'manual', label: 'You wrote it yourself' },
]

/**
 * The spec's node kinds, likewise. `entity` and `block` are the two that carry
 * no meaning outside this codebase — and because `<Field>` reads the same
 * `meta.options`, naming them here fixes the table cell and the filter dropdown
 * from one place.
 */
const KIND_OPTIONS = [
	{ value: 'entity', label: 'Kind of record' },
	{ value: 'field', label: 'Field' },
	{ value: 'page', label: 'Page' },
	{ value: 'block', label: 'Section of a page' },
	{ value: 'tier', label: 'Pricing plan' },
	{ value: 'flag', label: 'Feature flag' },
]

/**
 * Synthetic display-only resource: `QueueRow`s aren't a Sprout table, but
 * `<ResourceList>`/`<FilterForm>` only need the introspection *shape* — the
 * `enumValues` on `layer`/`kind`/`state` are what make `<FilterForm>` derive
 * dropdown facets and what make `<Field>` render `state` as an `EnumChip`
 * automatically (zero hand-written cell JSX for either column).
 *
 * The `meta.label`s matter more than they look: they name both the table header
 * *and* the filter control, so a raw column name here surfaces twice.
 */
const STRUCTURAL_QUEUE_RESOURCE: IntrospectedResource = {
	name: 'structuralQueueRow',
	primaryKey: 'id',
	columns: [
		{ name: 'id', type: 'string' },
		{
			name: 'layer',
			type: 'string',
			enumValues: ['data', 'page', 'pricing', 'flags'],
			meta: {
				label: 'Part of',
				options: [
					{ value: 'data', label: 'Data' },
					{ value: 'page', label: 'Pages' },
					{ value: 'pricing', label: 'Pricing' },
					{ value: 'flags', label: 'Feature flags' },
				],
			},
		},
		{
			name: 'kind',
			type: 'string',
			enumValues: ['entity', 'field', 'page', 'block', 'tier', 'flag'],
			meta: { label: 'What it is', options: KIND_OPTIONS },
		},
		{ name: 'label', type: 'string', meta: { label: 'Name' } },
		{
			name: 'state',
			type: 'string',
			enumValues: ['suggested', 'accepted', 'rejected', 'manual'],
			meta: { label: 'Status', options: STATE_OPTIONS },
		},
	],
}

/** Apply a `FilterValues` (from `<FilterForm>`) to plain rows client-side — the
 * queues are small, fully-loaded lists, so no server round-trip is needed; a
 * larger resource would wire `onChange` to the loader instead. */
function applyFilters(
	rows: Row[],
	resource: IntrospectedResource,
	values: FilterValues,
): Row[] {
	const search = values.search?.trim().toLowerCase()
	const searchable = search ? searchableFields(resource) : []
	return rows.filter((row) => {
		if (
			search &&
			!searchable.some((f) =>
				String(row[f] ?? '')
					.toLowerCase()
					.includes(search),
			)
		)
			return false
		for (const [col, want] of Object.entries(values.filter)) {
			if (want && String(row[col] ?? '') !== want) return false
		}
		for (const [col, range] of Object.entries(values.range ?? {})) {
			const v = Number(row[col])
			if (range.gte !== undefined && !(v >= Number(range.gte))) return false
			if (range.lte !== undefined && !(v <= Number(range.lte))) return false
		}
		return true
	})
}

function queueRowToRow(item: QueueRow): Row {
	return {
		id: item.id,
		layer: item.layer,
		kind: item.kind,
		label: item.label,
		state: item.state,
		_priority: item.priority,
		_pendingChildren: item.pendingChildren,
	}
}

/**
 * The structural inbox: one decision per entity/page/tier, cascading onto its
 * undecided fields/blocks. Off-surface-gap note: `<ResourceList>`'s
 * `bulkActions` selection model has no notion of "this row's decision also
 * covers its children" — cascade is inherently a per-row semantic, not a
 * per-selection one, so it stays a `ReviewButtons` action column rather than a
 * bulk toolbar. `selectable`/`bulkActions` genuinely don't fit this queue; the
 * ranked queue below (independent rows) is where bulk belongs, and it works
 * there without any friction.
 */
export function StructuralQueuePane({
	queue,
	filters,
	onFilterChange,
}: {
	queue: QueueRow[]
	filters: FilterValues
	onFilterChange: (next: FilterValues) => void
}) {
	const rows = useMemo(() => queue.map(queueRowToRow), [queue])
	const filtered = useMemo(
		() => applyFilters(rows, STRUCTURAL_QUEUE_RESOURCE, filters),
		[rows, filters],
	)

	return (
		<section className={paneClass}>
			<h2 className="mt-0 text-base font-semibold">
				Waiting for your OK{' '}
				<span className="font-normal text-muted-foreground">
					({filtered.length}
					{filtered.length !== queue.length ? ` of ${queue.length}` : ''}{' '}
					decision{filtered.length === 1 ? '' : 's'})
				</span>
			</h2>
			<p className="mt-0 text-[0.82rem] text-muted-foreground">
				Things your agent proposed that you have not decided on yet. One
				decision per page, entity or tier — keeping it also keeps the new fields
				underneath it (click the row to decide those one at a time). Turning
				something down records the decision; it never deletes anything.
			</p>
			<FilterForm
				resource={STRUCTURAL_QUEUE_RESOURCE}
				value={filters}
				onChange={onFilterChange}
				className="mb-3"
			/>
			<ResourceList
				resource={STRUCTURAL_QUEUE_RESOURCE}
				rows={filtered}
				emptyState={
					<p className="text-muted-foreground">
						{queue.length === 0
							? 'Nothing waiting on you. When your agent proposes a change, it shows up here.'
							: 'No rows match the current filter.'}
					</p>
				}
				// Cascade is a per-row semantic — one decision covering *this* row's
				// undecided children — so it cannot ride the selection model, which
				// assumes independent rows. `rowActions` (added to `<ResourceList>`
				// for #256) is where it belongs; before that existed these buttons
				// were rendered in a detached list under the table, lined up with
				// the rows only by luck.
				rowActions={(row) => {
					const source = queue.find((q) => q.id === row.id)
					return source ? <ReviewButtons target={source} cascade /> : null
				}}
				columns={{
					label: {
						render: ({ row }) => (
							<>
								<Link
									to={focusHref(String(row.id))}
									className="font-semibold text-foreground no-underline"
								>
									{String(row.label)}
								</Link>
								{row._priority === 'high' ? (
									<span
										title="Your agent flagged this one as high priority"
										className="ml-1.5 text-warning"
									>
										★
									</span>
								) : null}
								{(row._pendingChildren as { label: string }[]).length > 0 ? (
									<div className="text-[0.72rem] text-muted-foreground">
										keeping this also keeps{' '}
										{(row._pendingChildren as { label: string }[]).length} new:{' '}
										{(row._pendingChildren as { label: string }[])
											.map((c) => c.label)
											.join(' · ')}
									</div>
								) : null}
							</>
						),
					},
					// A row is in this queue either because it is itself undecided or
					// because something under it is. In the second case the row's own
					// state is `accepted`, and printing that next to "waiting for your
					// OK" is the contradiction #256 opened on. `<StateChip>` is silent
					// for settled rows, so the column now only ever says something the
					// reader can act on.
					state: {
						render: ({ value }) => <StateChip state={String(value)} />,
					},
				}}
			/>
		</section>
	)
}

// ---------------------------------------------------------------------------
// Ranked review queue — the priority-ranked triage inbox + dual-view
// toggle. This is the queue `<ResourceList>` fits best: independent
// rows, a real priority score, `selectable` + `bulkActions` map 1:1 onto the
// existing "accept all / reject all suggested" bulk triage the server
// (`submitTriage`) already supported (it takes N `issueKey`s in one post).
// ---------------------------------------------------------------------------

const RANKED_QUEUE_RESOURCE: IntrospectedResource = {
	name: 'rankedQueueItem',
	primaryKey: 'key',
	columns: [
		{ name: 'key', type: 'string' },
		{
			name: 'title',
			type: 'string',
			meta: { label: 'What people asked for' },
		},
		{
			name: 'state',
			type: 'string',
			enumValues: ['suggested', 'accepted', 'rejected', 'manual'],
			meta: { label: 'Status', options: STATE_OPTIONS },
		},
		{
			name: 'kind',
			type: 'string',
			enumValues: ['entity', 'field', 'page', 'block', 'tier', 'flag'],
			meta: { label: 'What it is', options: KIND_OPTIONS },
		},
		{ name: 'target', type: 'string', meta: { label: 'Affects' } },
		// `severity`, `score` and `feedbackCount` are still the sort keys and are
		// still rendered — inside the row's sentence and its "how this was ranked"
		// disclosure. As *columns* they were three bare numbers with no legend
		// ("I don't know what severity means or what the score means or feedback
		// count means"), and `hidden` takes them out of the filter bar too, where
		// they were offering a `>=`/`<=` range on numbers nobody could interpret.
		{ name: 'severity', type: 'number', meta: { hidden: true } },
		{ name: 'score', type: 'number', meta: { hidden: true } },
		{ name: 'feedbackCount', type: 'number', meta: { hidden: true } },
	],
}

/**
 * The score, in words.
 *
 * `score`, `severity` and `feedbackCount` shipped as three bare numeric columns
 * plus the literal string `score 4.20 = 3 reach × 4 sev × 0.80 conf ÷ 2 cost`.
 * #256: *"I don't know what severity means or what the score means or feedback
 * count means"* — and there was no way to find out from the page. The number is
 * still the sort key (it is the honest one), but a row now leads with the
 * sentence and keeps the arithmetic available for whoever wants to audit it.
 */
function priorityWord(score: number): string {
	if (score >= 4) return 'High'
	if (score >= 1.5) return 'Medium'
	return 'Low'
}

/** How bad it is for the people who hit it — the `severity` factor, 1–5. */
function severityWord(severity: number): string {
	if (severity >= 5) return 'blocks them completely'
	if (severity >= 4) return 'seriously in the way'
	if (severity >= 3) return 'annoying'
	if (severity >= 2) return 'minor'
	return 'cosmetic'
}

function queueItemToRow(item: QueueItem): Row {
	return {
		key: item.key,
		title: item.title,
		state: item.state,
		kind: item.targets[0]?.kind ?? 'unknown',
		target: item.targets.map((t) => `${t.kind}:${t.id}`).join(', '),
		severity: item.headline?.factors.severity ?? null,
		score: item.headline?.score ?? null,
		feedbackCount: item.feedbackCount,
	}
}

/**
 * The explicit Cluster trigger — the only place the real AI clusterer
 * ever runs (`ai-cluster.server.ts`'s `runAiClustering`); nothing in the
 * loader calls it. A plain POST + full reload (no client JS needed) so the
 * gate is enforced by the server regardless of what the client does.
 */
function ClusterFeedbackButton() {
	return (
		<Form method="post" className="inline-flex">
			<input type="hidden" name="intent" value="cluster" />
			<button type="submit" className={actionClass('neutral')}>
				Cluster feedback (AI)
			</button>
		</Form>
	)
}

/** Why this row is where it is, said in English first and arithmetic second. */
function FactorBreakdown({ item }: { item: QueueItem }) {
	if (!item.headline) {
		return (
			<span className="text-[0.72rem] text-muted-foreground">
				Nobody has proposed a fix for this yet.
			</span>
		)
	}
	const f = item.headline.factors
	return (
		<div className="text-[0.72rem] text-muted-foreground">
			<span className="font-medium text-foreground/80">
				{priorityWord(item.headline.score)} priority
			</span>{' '}
			— {severityWord(f.severity)}, affects {f.reach}{' '}
			{f.reach === 1 ? 'part' : 'parts'} of the app,{' '}
			{f.costWeight >= 8
				? 'and maxstack has no built-in way to do it'
				: f.costWeight >= 4
					? 'and takes real work to build'
					: 'and is cheap to build'}
			.{' '}
			<details className="inline">
				<summary className="inline cursor-pointer">how this was ranked</summary>
				<span className="tabular-nums">
					{' '}
					score {item.headline.score.toFixed(2)} = reach {f.reach} × severity{' '}
					{f.severity} × confidence {f.confidence.toFixed(2)} ÷ effort{' '}
					{f.costWeight}
				</span>
			</details>
		</div>
	)
}

export function RankedQueuePane({
	queue,
	filters,
	onFilterChange,
	params,
	activeDiffKey,
}: {
	queue: ReviewQueueModel
	filters: FilterValues
	onFilterChange: (next: FilterValues) => void
	/** Current URL search params — Diff links preserve them (queue view,
	 *  filters, focus) rather than resetting the page. */
	params: URLSearchParams
	activeDiffKey: string | null
}) {
	const s = queue.stats
	const rows = useMemo(() => queue.items.map(queueItemToRow), [queue.items])
	const filtered = useMemo(
		() => applyFilters(rows, RANKED_QUEUE_RESOURCE, filters),
		[rows, filters],
	)
	const byKey = useMemo(
		() => new Map(queue.items.map((i) => [i.key, i])),
		[queue.items],
	)

	return (
		<section className={`${paneClass} mt-5`}>
			{/* Not "Review queue". There were two panes by that name on this page —
			    this one and the structural inbox — which is most of why #256 says
			    "the review queue is zero I don't know": the empty one and the full
			    one had the same heading. This is the list of *asks*; the other is
			    the list of *proposed changes waiting on you*. */}
			<div className="mb-1 flex flex-wrap items-center justify-between gap-3">
				<h2 className="m-0 text-base font-semibold">Ideas &amp; feedback</h2>
				<div className="inline-flex items-center gap-2">
					<ClusterFeedbackButton />
					<ViewToggle view={queue.view} />
				</div>
			</div>
			<ViewExplainer view={queue.view} />

			<div className="mb-3.5 flex flex-wrap gap-2">
				<StatChip label="ideas" value={s.total} />
				<StatChip label="not decided" value={s.byState.suggested} />
				<StatChip label="agreed to" value={s.byState.accepted} />
				<StatChip label="turned down" value={s.byState.rejected} />
			</div>
			{s.moatGap > 0 ? (
				<p className="mt-0 mb-3.5 text-[0.78rem] text-muted-foreground">
					{s.moatGap} of these can only be built as hand-written code — maxstack
					has no declarative way to express them yet.
				</p>
			) : null}

			<FilterForm
				resource={RANKED_QUEUE_RESOURCE}
				value={filters}
				onChange={onFilterChange}
				className="mb-3"
			/>

			<ResourceList
				resource={RANKED_QUEUE_RESOURCE}
				rows={filtered}
				selectable
				emptyState={
					<p className="text-muted-foreground">
						{queue.items.length === 0
							? 'No issues captured yet.'
							: 'No rows match the current filter.'}
					</p>
				}
				columns={{
					title: {
						render: ({ row }) => {
							const item = byKey.get(String(row.key))
							const asks = row.feedbackCount as number
							return (
								<div>
									<div className="flex items-center gap-2">
										<span className="font-semibold">{row.title as string}</span>
										<span className="text-[0.7rem] text-muted-foreground">
											· {asks} {asks === 1 ? 'person asked' : 'people asked'}
										</span>
									</div>
									{item ? (
										<div className="mt-0.5">
											<FactorBreakdown item={item} />
										</div>
									) : null}
								</div>
							)
						},
					},
					state: {
						// An *idea* genuinely has a decision state — you either agreed it
						// was worth doing or you didn't — so unlike a spec row, showing
						// the settled value here is reporting a decision you did make.
						render: ({ value }) => (
							<StateChip state={String(value)} showSettled />
						),
					},
				}}
				rowActions={(row) => {
					const item = byKey.get(String(row.key))
					if (!item) return null
					const decided = item.state === 'accepted' || item.state === 'rejected'
					return (
						<>
							{item.landable ? (
								<Link
									to={diffHref(
										params,
										activeDiffKey === item.key ? null : item.key,
									)}
									title="See exactly what would change in your app"
									className={`${actionClass(
										activeDiffKey === item.key ? 'resolve' : 'neutral',
									)} no-underline`}
								>
									{activeDiffKey === item.key ? '✕ diff' : 'Diff'}
								</Link>
							) : null}
							{item.landed ? (
								<span className="text-[0.72rem] text-success">
									✓ in your app
								</span>
							) : item.state === 'accepted' && item.landable ? (
								<Form method="post" className="inline-flex">
									<input type="hidden" name="intent" value="land" />
									<input type="hidden" name="issueKey" value={item.key} />
									<button
										type="submit"
										title="Apply this change to your spec now"
										className={actionClass('resolve')}
									>
										Build it
									</button>
								</Form>
							) : null}
							<Form method="post" className="inline-flex gap-1.5">
								<input type="hidden" name="intent" value="triage" />
								<input type="hidden" name="issueKey" value={item.key} />
								{decided ? (
									<button
										type="submit"
										name="decision"
										value="clear"
										className={actionClass('neutral')}
									>
										Undo
									</button>
								) : (
									<>
										<button
											type="submit"
											name="decision"
											value="accept"
											title="Agree this is worth doing — it does not change your app yet"
											className={actionClass('accept')}
										>
											Worth doing
										</button>
										<button
											type="submit"
											name="decision"
											value="reject"
											className={actionClass('reject')}
										>
											Turn down
										</button>
									</>
								)}
							</Form>
						</>
					)
				}}
				bulkActions={({ selectedIds, clear }) => (
					<Form
						method="post"
						className="inline-flex items-center gap-1.5"
						onSubmit={() => clear()}
					>
						<input type="hidden" name="intent" value="triage" />
						{selectedIds.map((key) => (
							<input key={key} type="hidden" name="issueKey" value={key} />
						))}
						<button
							type="submit"
							name="decision"
							value="accept"
							className={actionClass('accept')}
						>
							Mark selected worth doing
						</button>
						<button
							type="submit"
							name="decision"
							value="reject"
							className={actionClass('reject')}
						>
							Turn selected down
						</button>
					</Form>
				)}
			/>
		</section>
	)
}
