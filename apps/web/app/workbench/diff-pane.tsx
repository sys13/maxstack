// ---------------------------------------------------------------------------
// Diff preview — before/after. Reuses the same rendered-HTML
// pane markup as the single-page `PreviewPane` (`dangerouslySetInnerHTML`
// over `renderGeneratedPage`'s output), just laid out twice side by side; all
// of the actual before/after computation lives server-side in
// `diff-preview.server.ts`.
// ---------------------------------------------------------------------------

import { Link } from 'react-router'
import type { DiffPreviewData } from './diff-preview.server'
import { paneClass } from './shared'

/** One rendered box (before or after). A highlighted dashed frame is the
 *  target-coordinate marker on both sides — the generator only emits DOM at
 *  page granularity (`data-resource`, no per-block/per-field ids), so a
 *  shared frame around the whole rendered page is the finest grain available
 *  without adding a second, deeper markup-tagging pass to the generator. */
function DiffRenderBox({
	label,
	rendered,
	emptyLabel,
}: {
	label: string
	rendered: DiffPreviewData['before']
	emptyLabel: string
}) {
	return (
		<div className="min-w-0 flex-1">
			<h4 className="mt-0 mb-1 text-[0.72rem] font-semibold tracking-wide text-muted-foreground uppercase">
				{label}
			</h4>
			<div className="rounded-md border-2 border-dashed border-warning/60 p-3">
				{rendered === null ? (
					<p className="m-0 text-[0.78rem] text-muted-foreground">
						{emptyLabel}
					</p>
				) : rendered.html !== null ? (
					<div
						// biome-ignore lint/security/noDangerouslySetInnerHtml: renderToStaticMarkup output of the platform's own generated modules (preview.server.ts / diff-preview.server.ts), not user-supplied markup
						dangerouslySetInnerHTML={{ __html: rendered.html }}
					/>
				) : (
					<p className="m-0 text-[0.78rem] text-destructive">
						Preview failed to render: {rendered.error}
					</p>
				)}
			</div>
		</div>
	)
}

/**
 * The diff pane itself: a review-queue item's before/after, target-highlighted
 * (the caption line + the shared frame both boxes render inside). Rendered
 * below the ranked queue when `?diff=<key>` is set (a "Diff" link on a
 * landable row), closable back to the plain queue.
 */
export function DiffPreviewPane({
	diff,
	closeHref,
}: {
	diff: DiffPreviewData
	closeHref: string
}) {
	return (
		<section className={`${paneClass} mt-5`}>
			<div className="mb-1 flex flex-wrap items-center justify-between gap-3">
				<h2 className="m-0 text-base font-semibold">
					Before / after —{' '}
					<span className="font-normal text-muted-foreground">
						{diff.title}
					</span>
				</h2>
				<Link to={closeHref} className="text-[0.8rem]">
					✕ close
				</Link>
			</div>
			<p className="mt-0 mb-3 text-[0.78rem] text-muted-foreground">
				Target:{' '}
				{diff.targets.length > 0
					? diff.targets.map((t) => `${t.kind}:${t.id}`).join(', ')
					: '(none)'}
				{diff.pageId ? ` · page ${diff.pageId}` : ''}
			</p>
			{diff.unavailableReason ? (
				<p className="text-[0.8rem] text-muted-foreground">
					No diff available — {diff.unavailableReason}
				</p>
			) : null}
			{diff.pageId ? (
				<div className="flex flex-col gap-4 md:flex-row">
					<DiffRenderBox
						label="Before (current spec)"
						rendered={diff.before}
						emptyLabel="This page doesn't exist in the current spec yet."
					/>
					<DiffRenderBox
						label="After (if accepted)"
						rendered={diff.after}
						emptyLabel="Not available."
					/>
				</div>
			) : null}
		</section>
	)
}
