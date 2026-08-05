/**
 * The top of the workbench: what needs you, in order.
 *
 * This pane exists because the workbench was "a set of panels rather than a
 * place". Eleven panes down a page is eleven things to check in declaration
 * order, with no answer to the question a maintainer actually arrives with. So
 * this goes **first**, and everything else becomes detail behind it.
 *
 * Three deliberate refusals:
 *
 *   1. **No badge, no count as the headline.** "17 pending" is a number, not
 *      attention. The list names specific rows, because nobody can act on a
 *      badge. The count appears underneath, as context.
 *   2. **Every item shows why it outranks the next.** A ranked list whose
 *      ranking cannot be explained is a ranking people learn to scroll past.
 *   3. **What could not be checked is on screen**, not swallowed. A clean report
 *      from a surface that could not look is indistinguishable from a real
 *      all-clear, and the second one is the dangerous mistake.
 *
 * Entirely server-rendered: no state, no effects, no client-only branches. Partly
 * restraint, mostly issue #138 — that bug class cannot be caught by a client-only
 * `render()`, and this is the first thing a maintainer sees, so a silent
 * hydration mismatch here would strand the most important panel on the page. The
 * hydration test drives a real `renderToString` + `hydrateRoot`.
 */

import type { AttentionItem, AttentionKind } from '@maxstack/mcp'
import type { AttentionView } from './attention.server'
import { paneClass } from './shared'

/**
 * How loud each category is.
 *
 * Mirrors `ATTENTION_KINDS`' order rather than restating a priority: the model
 * owns the ranking, this owns how it looks.
 */
const KIND_STYLE: Record<AttentionKind, { chip: string; label: string }> = {
	'public-change': {
		chip: 'bg-destructive text-destructive-foreground',
		label: 'PUBLIC',
	},
	removal: {
		chip: 'bg-destructive text-destructive-foreground',
		label: 'REMOVES',
	},
	unbatchable: {
		chip: 'bg-destructive/15 text-destructive',
		label: 'needs you',
	},
	'latent-exposure': {
		chip: 'bg-warning/15 text-warning',
		label: 'latent',
	},
	drift: {
		chip: 'bg-warning/15 text-warning',
		label: 'drift',
	},
	routine: { chip: 'bg-muted text-muted-foreground', label: 'routine' },
}

function Item({ item }: { item: AttentionItem }) {
	const style = KIND_STYLE[item.kind]
	return (
		<li className="border-border/60 border-b py-1.5 last:border-b-0">
			<div className="flex items-start gap-2">
				<span
					className={`mt-0.5 shrink-0 rounded px-1.5 py-0.5 text-[0.66rem] font-semibold uppercase ${style.chip}`}
				>
					{style.label}
				</span>
				<div className="min-w-0 flex-1">
					{/* The model emits `**bold**` around the public-boundary phrases. It
					    is rendered as plain text rather than parsed as markdown: the
					    strings are ours, but running a parser over content that will one
					    day include a field name somebody chose is how an injection lands. */}
					<div className="text-[0.86rem] font-medium">
						{item.title.replace(/\*\*/g, '')}
					</div>
					<div className="text-[0.74rem] text-muted-foreground">
						{item.because}
					</div>
					{item.where ? (
						<div className="text-[0.72rem] text-muted-foreground">
							→ {item.where}
						</div>
					) : null}
				</div>
			</div>
		</li>
	)
}

/** The derived consequences of clearing the queue — the blast radius, summarised. */
function Consequences({ radius }: { radius: AttentionView['radius'] }) {
	return (
		<div className="mt-3 rounded-md border border-border p-2">
			<h3 className="mb-1 text-[0.82rem] font-semibold">
				If you accept everything pending
			</h3>
			<p className="m-0 text-[0.82rem]">{radius.summary}</p>
			{radius.groundingNote ? (
				// Without this, an empty result reads as "this op does nothing", which is
				// the wrong lesson and the reason the note exists at all.
				<p className="mt-1 text-[0.74rem] text-muted-foreground">
					{radius.groundingNote}
				</p>
			) : null}
			{radius.removed.length > 0 ? (
				<ul className="mt-1 mb-0 list-none p-0">
					{radius.removed.map((surface) => (
						<li key={surface.id} className="text-[0.78rem] text-destructive">
							STOPS EXISTING: {surface.label.replace(/\*\*/g, '')}
						</li>
					))}
				</ul>
			) : null}
			<p className="mt-1 mb-0 text-[0.72rem] text-muted-foreground">
				{radius.added.length} added · {radius.changed.length} changed ·{' '}
				{radius.unchanged} unchanged. Same numbers from{' '}
				<code>maxstack review --section blast-radius</code>.
			</p>
		</div>
	)
}

/** What the internet can reach — the item #198 calls the most important one. */
function Exposure({
	exposed,
	latent,
}: {
	exposed: AttentionView['exposed']
	latent: AttentionView['latent']
}) {
	if (exposed.length === 0 && latent.length === 0) {
		return (
			<p className="mt-3 mb-0 text-[0.78rem] text-muted-foreground">
				No portal declares anything — nothing in this project is publicly
				reachable.
			</p>
		)
	}
	return (
		<div className="mt-3 rounded-md border border-destructive/40 p-2">
			<h3 className="mb-1 text-[0.82rem] font-semibold text-destructive">
				Publicly reachable ({exposed.length})
			</h3>
			<ul className="m-0 list-none p-0">
				{exposed.map((surface) => (
					<li key={surface.id} className="text-[0.8rem]">
						{surface.label.replace(/\*\*/g, '')}
						{surface.detail ? (
							<span className="ml-1 text-muted-foreground">
								{surface.detail}
							</span>
						) : null}
					</li>
				))}
			</ul>
			{latent.length > 0 ? (
				<>
					<h3 className="mt-2 mb-1 text-[0.82rem] font-semibold">
						One op from public ({latent.length})
					</h3>
					<ul className="m-0 list-none p-0">
						{latent.map((item) => (
							<li key={item.key} className="text-[0.78rem]">
								<span className="font-medium">{item.key}</span> over{' '}
								{item.entityId} — {item.fields} field
								{item.fields === 1 ? '' : 's'}
								<span className="block text-[0.72rem] text-muted-foreground">
									{item.reason}
								</span>
							</li>
						))}
					</ul>
				</>
			) : null}
		</div>
	)
}

export function AttentionPane({ attention }: { attention: AttentionView }) {
	const { report, radius, exposed, latent } = attention
	return (
		<section className={paneClass}>
			<h2 className="mt-0 text-base font-semibold">What needs you</h2>
			{/* The headline is *about* the list — the worst category, its size, and
			    what is behind it — or an honest refusal to claim an all-clear. It was
			    the top item's title verbatim, which rendered this paragraph and the
			    first `<li>` under it as the same sentence twice; the model owns that
			    now (`headlineFor`), so no renderer has to remember to skip a row. */}
			{/* Stripped like the item titles. The headline is the single most prominent
			    string on the page, so it is the last place literal `**` should show up —
			    and it was, until a hydration test read the rendered text. */}
			<p className="mt-0 mb-2 text-[0.9rem]">
				{report.headline.replace(/\*\*/g, '')}
			</p>

			{report.items.length > 0 ? (
				<ul className="m-0 list-none p-0">
					{report.items.map((item, i) => (
						// biome-ignore lint/suspicious/noArrayIndexKey: the value alone is not unique and there is no id on this row; the list is loader-rendered and never reordered client-side, so value:index is stable
						<Item key={`${item.id}:${i}`} item={item} />
					))}
				</ul>
			) : null}

			<p className="mt-2 mb-0 text-[0.74rem] text-muted-foreground">
				{report.pending} proposal{report.pending === 1 ? '' : 's'} pending. The
				same ordering, in the terminal: <code>maxstack review</code>.
			</p>

			{report.unavailable.length > 0 ? (
				<div className="mt-2 rounded-md border border-warning/50 p-2">
					<h3 className="mb-1 text-[0.8rem] font-semibold">Not checked</h3>
					<ul className="m-0 list-disc pl-4">
						{report.unavailable.map((gap, i) => (
							<li
								// biome-ignore lint/suspicious/noArrayIndexKey: the value alone is not unique and there is no id on this row; the list is loader-rendered and never reordered client-side, so value:index is stable
								key={`${gap}:${i}`}
								className="text-[0.74rem] text-muted-foreground"
							>
								{gap}
							</li>
						))}
					</ul>
				</div>
			) : null}

			<Consequences radius={radius} />
			<Exposure exposed={exposed} latent={latent} />
		</section>
	)
}
