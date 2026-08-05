/**
 * @vitest-environment jsdom
 *
 * The claims in issue #256, pinned as tests.
 *
 * #256 is a usability report, and usability is mostly not testable. But four of
 * its complaints are statements about the DOM, and each one describes a specific
 * way this surface lied to the person reading it. Those are worth a regression
 * test, because every one of them is the kind of thing that creeps straight back
 * in the next time a pane is added:
 *
 *   1. *"all these fields like title are all accepted when I didn't actually do
 *      accepting anything"* — a settled row must not carry a decision badge.
 *   2. *"the second reject buttons are not in line with anything"* — a per-row
 *      control must live inside its own row.
 *   3. *"the review queue is zero I don't know"* — two panes must not share a
 *      heading.
 *   4. *"I don't know what severity means or what the score means"* — a number
 *      on this surface must arrive with its meaning attached.
 *
 * A fifth was recorded in #256's close as unfixed and is now fixed here: the
 * attention pane printed its headline and then repeated it verbatim as its own
 * first list item. The model change is in `@maxstack/mcp` (`headlineFor` no longer
 * reads a title), and this asserts the consequence where a reader would see it.
 */

import { attentionReport } from '@maxstack/mcp'
import { applyOp, newSpecSystem, type OpId, suggested } from '@maxstack/spec'
import { tasklyPRD } from '@maxstack/spec/fixtures'
import type { ReactNode } from 'react'
import { renderToString } from 'react-dom/server'
import { createRoutesStub } from 'react-router'
import { describe, expect, it } from 'vitest'
import { AppSpine } from './app-spine'
import type { AttentionView } from './attention.server'
import { AttentionPane } from './attention-pane'
import { RankedQueuePane, StructuralQueuePane } from './queue-panes'
import type { ReviewQueueModel } from './review-queue'
import { StateChip } from './shared'
import type { QueueRow, SpecTreeLayer } from './view-model'

/** Server markup for a pane — these are all server-rendered by design,
 *  so the server string is the honest thing to assert against. */
function ssr(ui: ReactNode): string {
	const Stub = createRoutesStub([{ path: '/', Component: () => <>{ui}</> }])
	return renderToString(<Stub initialEntries={['/']} />)
}

function dom(ui: ReactNode): HTMLElement {
	const el = document.createElement('div')
	el.innerHTML = ssr(ui)
	return el
}

// ---------------------------------------------------------------------------

describe('a settled row claims no decision', () => {
	it('renders no badge for accepted or manual', () => {
		// `deriveProvenanceState` marks anything settled `accepted`, including
		// every op the maintainer's own agent authored. Badging that "accepted"
		// told people they had reviewed things they had never seen.
		expect(dom(<StateChip state="accepted" />).textContent).toBe('')
		expect(dom(<StateChip state="manual" />).textContent).toBe('')
	})

	it('renders a badge only for the two states that are about the reader', () => {
		expect(dom(<StateChip state="suggested" />).textContent).toContain(
			'needs your OK',
		)
		expect(dom(<StateChip state="rejected" />).textContent).toContain(
			'turned down',
		)
	})

	it('still reports a decision where the decision is the subject', () => {
		// The ledger and per-node history genuinely are about what was decided.
		expect(
			dom(<StateChip state="accepted" showSettled />).textContent,
		).toContain('in your app')
	})
})

// ---------------------------------------------------------------------------

const queue: QueueRow[] = [
	{
		kind: 'entity',
		id: 'e-task',
		layer: 'data',
		label: 'Task',
		description: null,
		state: 'suggested',
		priority: 'medium',
		pendingChildren: [],
	},
	{
		// The row that produced complaint (1): the entity itself is settled, and it
		// is in this queue only because something under it is not.
		kind: 'page',
		id: 'p-tasks',
		layer: 'page',
		label: 'Tasks (/tasks)',
		description: null,
		state: 'accepted',
		priority: 'medium',
		pendingChildren: [
			{
				kind: 'block',
				id: 'b-1',
				parentId: 'p-tasks',
				layer: 'page',
				label: 'list',
				description: null,
				state: 'suggested',
				priority: 'medium',
			},
		],
	},
]

describe('per-row controls live in their row', () => {
	const el = dom(
		<StructuralQueuePane
			queue={queue}
			filters={{ search: '', filter: {} }}
			onFilterChange={() => {}}
		/>,
	)

	it('puts Keep and Turn down inside the row they act on', () => {
		const rows = Array.from(el.querySelectorAll('tbody tr'))
		expect(rows).toHaveLength(2)
		for (const row of rows) {
			const labels = Array.from(row.querySelectorAll('button')).map((b) =>
				b.textContent?.trim(),
			)
			expect(labels).toContain('Keep')
			expect(labels).toContain('Turn down')
		}
	})

	it('leaves no buttons stranded outside the table', () => {
		// The old shape: <table> … </table> followed by a <ul> of right-aligned
		// button pairs, lined up with the rows by luck and by nothing else.
		const outside = Array.from(el.querySelectorAll('button')).filter(
			(b) => !b.closest('table'),
		)
		expect(outside).toHaveLength(0)
	})

	it('does not badge the settled parent row as accepted', () => {
		const parentRow = Array.from(el.querySelectorAll('tbody tr')).find((r) =>
			r.textContent?.includes('Tasks (/tasks)'),
		)
		expect(parentRow?.textContent).not.toContain('accepted')
		// …and it does say why it is in the queue at all.
		expect(parentRow?.textContent).toContain('keeping this also keeps 1 new')
	})
})

// ---------------------------------------------------------------------------

describe('two lists, two names', () => {
	const ranked: ReviewQueueModel = {
		view: 'product',
		items: [],
		stats: {
			total: 0,
			byState: { suggested: 0, accepted: 0, rejected: 0, manual: 0 },
			moatGap: 0,
		},
	}

	function headings(el: HTMLElement): string[] {
		return Array.from(el.querySelectorAll('h2')).map(
			(h) => h.textContent?.trim() ?? '',
		)
	}

	it('gives the two queues different headings', () => {
		// Both panes were titled "Review queue". One of them was usually empty,
		// which is how "the review queue is zero I don't know" happens on a page
		// that also has a full review queue on it.
		const structural = headings(
			dom(
				<StructuralQueuePane
					queue={queue}
					filters={{ search: '', filter: {} }}
					onFilterChange={() => {}}
				/>,
			),
		)
		const rankedHeadings = headings(
			dom(
				<RankedQueuePane
					queue={ranked}
					filters={{ search: '', filter: {} }}
					onFilterChange={() => {}}
					params={new URLSearchParams()}
					activeDiffKey={null}
				/>,
			),
		)
		expect(structural.join()).toContain('Waiting for your OK')
		expect(rankedHeadings.join()).toContain('Ideas & feedback')
		for (const h of [...structural, ...rankedHeadings])
			expect(h).not.toContain('Review queue')
	})

	it('says who each ordering is for, not just what it divides', () => {
		const el = dom(
			<RankedQueuePane
				queue={ranked}
				filters={{ search: '', filter: {} }}
				onFilterChange={() => {}}
				params={new URLSearchParams()}
				activeDiffKey={null}
			/>,
		)
		// "demand ÷ cost" and "Platform backlog" both assume you know that
		// *platform* means maxstack itself rather than your app.
		expect(el.textContent).not.toContain('demand ÷ cost')
		expect(el.textContent).not.toContain('Platform backlog')
		expect(el.textContent).toContain('if you are building your app')
	})
})

describe('the attention pane says each thing once', () => {
	// Built from the real fold rather than a literal: a hand-written `report` would
	// let this test keep passing with the duplication put straight back into
	// `headlineFor`, which is the only place it can come from.
	let spec = newSpecSystem(tasklyPRD)
	spec = applyOp(
		spec,
		{
			op: 'data.addEntity',
			args: {
				entity: {
					id: 'e-order',
					name: 'Order',
					provenance: suggested(),
					fields: [
						{
							id: 'fld-total',
							name: 'total',
							type: 'number',
							required: true,
							provenance: suggested(),
						},
					],
				},
			},
		},
		{
			id: 'op-leg-1' as OpId,
			origin: 'ai',
			appliedAt: '2026-07-31',
			actor: { surface: 'harness', path: 'legibility-test' },
		},
	)
	const attention: AttentionView = {
		report: attentionReport(spec, {
			risk: { ownedEntityIds: [], ownedPageIds: [], ownershipKnown: true },
			drift: [],
			upgrades: [],
		}),
		radius: {
			added: [],
			removed: [],
			changed: [],
			unchanged: 0,
			summary: '',
			groundingNote: null,
			touchesPublic: false,
		},
		exposed: [],
		latent: [],
	}
	const el = dom(<AttentionPane attention={attention} />)

	it('has something to say', () => {
		// Guards the test itself: an empty report would satisfy every assertion
		// below while proving nothing.
		expect(attention.report.items.length).toBeGreaterThan(0)
	})

	it('does not repeat the headline as its own first item', () => {
		const title = attention.report.items[0]?.title.replace(/\*\*/g, '') ?? ''
		expect(title.length).toBeGreaterThan(0)
		const headline = el.querySelector('p')?.textContent?.trim() ?? ''
		expect(headline).not.toBe(title)
		// And the sentence appears on the page exactly once: the list item's own
		// line, and nowhere above it. Under the old model the headline `<p>` matched
		// this too, which is precisely what the reader was seeing.
		const printed = Array.from(el.querySelectorAll('*')).filter(
			(node) => node.textContent?.trim() === title,
		)
		expect(printed).toHaveLength(1)
	})

	it('leads with the shape of the queue, not with one row', () => {
		expect(el.textContent).toContain('routine item')
	})
})

describe('the app spine leads with the app', () => {
	const tree: SpecTreeLayer[] = [
		{
			layer: 'product',
			label: 'Taskly',
			counts: { suggested: 0, accepted: 0, rejected: 0, manual: 0, total: 0 },
			items: [],
		},
		{
			layer: 'data',
			label: 'Data',
			counts: { suggested: 1, accepted: 2, rejected: 0, manual: 0, total: 3 },
			items: [
				{
					kind: 'entity',
					id: 'e-task',
					layer: 'data',
					label: 'Task',
					description: null,
					state: 'accepted',
					priority: 'medium',
					children: [
						{
							kind: 'field',
							id: 'f-due',
							parentId: 'e-task',
							layer: 'data',
							label: 'dueDate: date',
							description: null,
							state: 'suggested',
							priority: 'medium',
						},
					],
				},
				{
					kind: 'entity',
					id: 'e-user',
					layer: 'data',
					label: 'User',
					description: null,
					state: 'accepted',
					priority: 'medium',
					children: [],
				},
			],
		},
	]
	const el = dom(<AppSpine tree={tree} focusId={null} />)

	it('counts what is waiting, and says nothing when nothing is', () => {
		const taskLink = Array.from(el.querySelectorAll('a')).find((a) =>
			a.textContent?.startsWith('Task'),
		)
		expect(taskLink?.textContent).toBe('Task1')
		const userLink = Array.from(el.querySelectorAll('a')).find(
			(a) => a.textContent === 'User',
		)
		// A calm app should not be a wall of zeroes.
		expect(userLink?.textContent).toBe('User')
	})

	it('drops the product layer, which only ever rendered a label', () => {
		expect(el.textContent).not.toContain('PRD (product layer)')
	})

	it('does not print the four-count provenance status line per layer', () => {
		expect(el.textContent).not.toContain('suggested')
		expect(el.textContent).not.toContain('manual')
	})
})
