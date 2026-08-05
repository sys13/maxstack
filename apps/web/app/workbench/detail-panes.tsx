// ---------------------------------------------------------------------------
// Middle pane — focused-node detail (rows, acceptance criteria, live preview)
// ---------------------------------------------------------------------------

import { History } from '@maxstack/ui'
import { Form, Link } from 'react-router'
import { AgentHandoff } from './agent-handoff'
import { actionClass, paneClass, ReviewButtons, StateChip } from './shared'
import type { TelemetryView } from './telemetry.server'
import { useConfusionSignal } from './use-confusion-signal'
import type { DetailRow, FocusDetail, WorkbenchView } from './view-model'
import type { PreviewFile, WorkbenchPageData } from './workbench.server'

function DetailRows({ rows }: { rows: DetailRow[] }) {
	if (rows.length === 0) return null
	return (
		<ul className="m-1 list-none p-0">
			{rows.map((r, i) => (
				<li
					// biome-ignore lint/suspicious/noArrayIndexKey: the value alone is not unique and there is no id on this row; the list is loader-rendered and never reordered client-side, so value:index is stable
					key={`${r.label}:${i}`}
					className="flex items-center gap-1.5 py-0.5 text-sm"
				>
					<span>{r.label}</span>
					{/* After the label, not before it: a badge in the leading position
					    made every row look like a status row, when for all but the
					    undecided few there is no status to report. */}
					<StateChip state={r.state} />
					{r.sub ? (
						<span className="text-[0.78rem] text-muted-foreground">
							{r.sub}
						</span>
					) : null}
					{r.ref && r.state === 'suggested' ? (
						<ReviewButtons target={r.ref} />
					) : null}
				</li>
			))}
		</ul>
	)
}

function PreviewPane({
	preview,
	notes,
	html,
	error,
}: {
	preview: PreviewFile[]
	notes: string[]
	html: string | null
	error: string | null
}) {
	return (
		<div className="mt-4">
			<h3 className="mb-1 text-sm font-semibold">Live preview</h3>
			<p className="mt-0 mb-2 text-[0.75rem] text-muted-foreground">
				The page the ownership <code>page</code> generator emits for this spec
				node, <em>rendered</em> — the emitted modules (route + user slot file)
				evaluated through the real <code>&lt;Slot&gt;</code> runtime, the same
				generator the MCP <code>run_generator</code> tool drives.
			</p>
			{html ? (
				<div
					className="mb-2.5 rounded-md border border-dashed border-border p-3"
					// biome-ignore lint/security/noDangerouslySetInnerHtml: renderToStaticMarkup output of the platform's own generated modules (preview.server.ts), not user-supplied markup
					dangerouslySetInnerHTML={{ __html: html }}
				/>
			) : (
				<p className="text-[0.75rem] text-destructive">
					Preview failed to render: {error}
				</p>
			)}
			<h4 className="mt-2.5 mb-1 text-[0.8rem] font-semibold">
				Generated source
			</h4>
			{notes.length > 0 ? (
				<ul className="pl-4 text-[0.75rem] text-muted-foreground">
					{notes.map((n, i) => (
						// biome-ignore lint/suspicious/noArrayIndexKey: the value alone is not unique and there is no id on this row; the list is loader-rendered and never reordered client-side, so value:index is stable
						<li key={`${n}:${i}`}>{n}</li>
					))}
				</ul>
			) : null}
			{preview.map((f, i) => (
				// biome-ignore lint/suspicious/noArrayIndexKey: the value alone is not unique and there is no id on this row; the list is loader-rendered and never reordered client-side, so value:index is stable
				<details key={`${f.path}:${i}`} className="mb-1.5">
					<summary className="cursor-pointer font-mono text-[0.8rem]">
						{f.path}
					</summary>
					<pre className="overflow-x-auto rounded-md bg-muted p-2.5 text-[0.72rem]">
						{f.content}
					</pre>
				</details>
			))}
		</div>
	)
}

export function DetailPane({
	detail,
	history,
	preview,
	previewNotes,
	previewHtml,
	previewError,
}: {
	detail: FocusDetail
	history: WorkbenchPageData['history']
	preview: PreviewFile[] | null
	previewNotes: string[]
	previewHtml: string | null
	previewError: string | null
}) {
	// Real browser focus/blur cycling on this node — the genuinely client-side
	// half of implicit confusion feedback; server telemetry only
	// ever sees one `focus` per route load, so it can't detect this pattern.
	const confusion = useConfusionSignal({ kind: detail.kind, id: detail.id })
	return (
		// biome-ignore lint/a11y/noStaticElementInteractions: passive telemetry listener (React focus bubbling), not a custom control — no role/keyboard semantics apply
		<section className={paneClass} onFocus={confusion.onFocus}>
			<div className="flex justify-between gap-4">
				<h2 className="mt-0 text-base font-semibold">
					<span className="font-normal text-muted-foreground">
						{detail.kind} ·{' '}
					</span>
					{detail.title}
				</h2>
				<Link to="?" className="text-[0.8rem]">
					← overview
				</Link>
			</div>
			<div className="flex items-center gap-2">
				<StateChip state={detail.state} />
				{detail.subtitle ? (
					<span className="text-[0.85rem] text-muted-foreground">
						{detail.subtitle}
					</span>
				) : null}
			</div>

			{/* The whole reason to arrive here: change this thing. It goes above the
			    inventory, because "what is in it" is reference material and "how do I
			    change it" was the unanswered question. */}
			<AgentHandoff
				target={{ kind: detail.kind, label: detail.title }}
				className="mt-3"
			/>

			<h3 className="mt-4 mb-0.5 text-[0.85rem] font-semibold">
				{detail.kind === 'entity'
					? 'What it stores'
					: detail.kind === 'page'
						? 'What is on it'
						: 'What it includes'}
			</h3>
			<DetailRows rows={detail.rows} />

			{detail.derivedPages.length > 0 ? (
				<>
					<h3 className="mt-3 mb-0.5 text-[0.85rem] font-semibold">
						Screens built from this
					</h3>
					<DetailRows rows={detail.derivedPages} />
				</>
			) : null}

			{detail.acceptanceCriteria.length > 0 ? (
				<>
					<h3 className="mt-3 mb-0.5 text-[0.85rem] font-semibold">
						What it has to do to be correct
					</h3>
					<ul className="my-1 pl-4 text-[0.85rem]">
						{detail.acceptanceCriteria.map((c, i) => (
							// biome-ignore lint/suspicious/noArrayIndexKey: the value alone is not unique and there is no id on this row; the list is loader-rendered and never reordered client-side, so value:index is stable
							<li key={`${c}:${i}`}>{c}</li>
						))}
					</ul>
				</>
			) : null}

			{preview ? (
				<PreviewPane
					preview={preview}
					notes={previewNotes}
					html={previewHtml}
					error={previewError}
				/>
			) : null}

			{/* Per-target audit trail over the spec's op log — the free win: this
			    was `/admin`-only (per-record CRUD audit) before #12; here it's the
			    review trail behind every accept/reject on this node. */}
			<div className="mt-4 border-t border-border pt-4">
				<History entries={history} title="History" />
			</div>
		</section>
	)
}

// ---------------------------------------------------------------------------
// Right pane — decisions (with resolve) + telemetry feed
// ---------------------------------------------------------------------------

/**
 * Open questions the maintainer has to answer, and what they answered before.
 *
 * Split from the activity feed it used to share a pane with: a
 * question waiting on you and a log of what already happened are opposite kinds
 * of thing, and stacking them made the pane look like a status readout that
 * happened to contain a form. The feed now lives in Diagnostics.
 */
export function DecisionsPane({ view }: { view: WorkbenchView }) {
	const { pending, resolved } = view.decisions
	return (
		<section className={paneClass}>
			<h2 className="mt-0 text-base font-semibold">Questions for you</h2>
			<h3 className="mb-1 text-[0.85rem] font-semibold">
				Waiting ({pending.length})
			</h3>
			{pending.length === 0 ? (
				<p className="text-[0.82rem] text-muted-foreground">
					Nothing to answer right now.
				</p>
			) : (
				pending.map((d) => (
					<Form
						method="post"
						key={d.id}
						className="mb-3 border-b border-border pb-2"
					>
						<input type="hidden" name="intent" value="resolve" />
						<input type="hidden" name="decisionId" value={d.id} />
						<div className="text-[0.88rem] font-semibold">{d.question}</div>
						<div className="my-1">
							{d.options.map((o) => (
								<label key={o.id} className="my-0.5 block text-[0.8rem]">
									<input
										type="radio"
										name="optionId"
										value={o.id}
										defaultChecked={o.id === d.recommendedOptionId}
									/>{' '}
									{o.description}
									{o.id === d.recommendedOptionId ? (
										<span className="text-muted-foreground">
											{' '}
											(recommended)
										</span>
									) : null}
								</label>
							))}
						</div>
						<input
							name="rationale"
							placeholder="rationale (why)…"
							className="mb-1.5 w-full box-border rounded-md border border-input bg-transparent px-1.5 py-1 text-[0.78rem]"
						/>
						<button type="submit" className={actionClass('resolve')}>
							Resolve
						</button>
					</Form>
				))
			)}

			<h3 className="mt-3 mb-1 text-[0.85rem] font-semibold">
				Already answered ({resolved.length})
			</h3>
			{resolved.length === 0 ? (
				<p className="text-[0.82rem] text-muted-foreground">
					Nothing answered yet.
				</p>
			) : (
				<ul className="pl-4 text-[0.82rem]">
					{resolved.map((d) => (
						<li key={d.id} className="mb-1">
							<div className="font-semibold">{d.question}</div>
							<div className="text-foreground/80">
								→{' '}
								{d.options.find((o) => o.id === d.chosenOptionId)?.description}
							</div>
							{d.rationale ? (
								<div className="text-muted-foreground">{d.rationale}</div>
							) : null}
						</li>
					))}
				</ul>
			)}
		</section>
	)
}

/** The workbench's own usage log — what you did here, not what your app does.
 *  Diagnostics material: useful when something looks wrong, noise otherwise. */
export function ActivityPane({ telemetry }: { telemetry: TelemetryView }) {
	return (
		<section className={paneClass}>
			<h2 className="mt-0 text-base font-semibold">
				Your activity here ({telemetry.summary.total})
			</h2>
			<p className="mt-0 mb-2 text-[0.78rem] text-muted-foreground">
				What you have done in this workbench — {telemetry.summary.byKind.accept}{' '}
				kept · {telemetry.summary.byKind.reject} turned down ·{' '}
				{telemetry.summary.byKind.resolve} questions answered ·{' '}
				{telemetry.summary.byKind.focus} things opened.
			</p>
			<ul className="m-0 list-none p-0 text-[0.75rem]">
				{telemetry.recent.map((e, i) => (
					// biome-ignore lint/suspicious/noArrayIndexKey: the value alone is not unique and there is no id on this row; the list is loader-rendered and never reordered client-side, so value:index is stable
					<li key={`${e.at}:${i}`} className="py-0.5 text-foreground/75">
						<code>{e.kind}</code>
						{e.targetId ? ` ${e.targetId}` : ''}
						{e.detail ? ` → ${e.detail}` : ''}
					</li>
				))}
			</ul>
		</section>
	)
}
