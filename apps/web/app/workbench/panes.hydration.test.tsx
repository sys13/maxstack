/**
 * @vitest-environment jsdom
 *
 * Hydration correctness for the workbench panes (gating requirement).
 *
 * #198 makes server-render tests **mandatory** for this surface, and the reason is
 * #138: `useStore` passed a localStorage-reading `getSnapshot` as
 * `getServerSnapshot`, so a returning visitor hydrated against markup the server
 * never sent. It shipped green because a client-only `render()` never calls
 * `getServerSnapshot` at all. Every test in this file therefore drives a **real**
 * `renderToString` followed by a **real** `hydrateRoot`, in the same shape as
 * `packages/ui/src/prefs/prefs-context.hydration.test.tsx`.
 *
 * The signal asserted on is `onRecoverableError`, not `console.error` and not the
 * final DOM. React 19 recovers from a mismatch by client-rendering the subtree and
 * still lands on correct-looking markup, so a DOM assertion passes either way —
 * which is exactly how this class of bug hides. `onRecoverableError` is React's own
 * "hydration did not match, I patched it up" channel.
 *
 * Why it matters most here: the attention pane is the *first* thing on the page.
 * A stranded subtree there is a maintainer reading a stale list of what needs them.
 */

import type { AttentionReport, BlastRadius } from '@maxstack/mcp'
import type { ReactNode } from 'react'
import { act } from 'react'
import { hydrateRoot } from 'react-dom/client'
import { renderToString } from 'react-dom/server'
import { createRoutesStub } from 'react-router'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { AttentionView } from './attention.server'
import { AttentionPane } from './attention-pane'
import { BulkReviewPane } from './bulk-review-pane'
import { IntentPane } from './intent-pane'
import { ReviewCostPane } from './review-cost-pane'

/**
 * Server-render `ui`, put the markup in a container, then hydrate the *same* tree.
 *
 * Same tree on both sides deliberately: these panes take all their data as props
 * from a loader, so identical input is the real production condition and any
 * mismatch it produces is an intrinsic one — a `Date.now()`, a `Math.random()`, a
 * `typeof window` branch, a locale-dependent format. Those are the ways a
 * server-rendered pane goes wrong when it holds no client state, and they are
 * invisible to a client-only render.
 */
async function ssrThenHydrate(
	ui: ReactNode,
): Promise<{ container: HTMLElement; errors: string[]; html: string }> {
	// The panes render `<Form>`, which needs a router context on both sides.
	const Stub = createRoutesStub([{ path: '/', Component: () => <>{ui}</> }])
	const tree = <Stub initialEntries={['/']} />

	const html = renderToString(tree)
	const container = document.createElement('div')
	container.innerHTML = html
	document.body.appendChild(container)

	const errors: string[] = []
	const spy = vi.spyOn(console, 'error').mockImplementation(() => {})
	try {
		await act(async () => {
			hydrateRoot(container, tree, {
				onRecoverableError: (error) => {
					errors.push(String((error as Error)?.message ?? error))
				},
			})
		})
	} finally {
		spy.mockRestore()
	}
	return { container, errors, html }
}

// ---------------------------------------------------------------------------
// Fixtures — shaped like a busy project, not a demo one
// ---------------------------------------------------------------------------

const report: AttentionReport = {
	items: [
		{
			kind: 'public-change',
			id: 'attention:public-field:order.total',
			title:
				'**`order.total` is readable by the public internet** if you accept',
			because: 'this is the only category that cannot be undone',
			where: 'via the `orders` portal',
		},
		{
			kind: 'unbatchable',
			id: 'attention:proposal:field:fld-role',
			title: 'viewerRole (field) needs an individual decision',
			because: '"viewerRole" reads as access control',
			where: 'fld-role',
		},
		{
			kind: 'routine',
			id: 'attention:batchable',
			title: '204 routine proposals can be cleared in a batch',
			because: 'nothing in this set touches access control',
			where: null,
		},
	],
	unavailable: ['drift — this host cannot read the filesystem'],
	// Shaped like what `headlineFor` now produces: about the list, not a copy of a
	// line in it. The `**` is kept so the stripping assertion below still has
	// something to strip.
	headline:
		'**1** change would put data on the public internet, and that is the one category you cannot take back, then 2 more below.',
	pending: 205,
}

const radius: BlastRadius = {
	added: [
		{
			kind: 'column',
			id: 'column:order.sku',
			label: '`order.sku`',
			detail: 'string',
		},
	],
	removed: [
		{
			kind: 'column',
			id: 'column:order.legacy',
			label: '`order.legacy`',
			detail: 'string',
		},
	],
	changed: [
		{
			surface: {
				kind: 'table',
				id: 'table:order',
				label: 'the `order` table',
				detail: '3 columns',
			},
			before: '2 columns',
			after: '3 columns',
		},
	],
	unchanged: 41,
	summary: 'REMOVES 1 derived surface; adds 1; changes 1',
	groundingNote: null,
	touchesPublic: true,
}

const attention: AttentionView = {
	report,
	radius,
	exposed: [
		{
			kind: 'public-field',
			id: 'public-field:order.total',
			label: '**`order.total` is readable by the public internet**',
			detail: 'via the `orders` portal',
		},
	],
	latent: [
		{
			key: 'archive',
			entityId: 'e-order',
			fields: 3,
			reason: 'paused — un-pausing publishes it again with no further review',
		},
	],
}

describe('AttentionPane hydrates cleanly', () => {
	beforeEach(() => {
		document.body.innerHTML = ''
	})

	it('server-renders the ordered list and hydrates with no mismatch', async () => {
		const { html, errors, container } = await ssrThenHydrate(
			<AttentionPane attention={attention} />,
		)
		// The content is really in the SSR markup, not only after hydration — this is
		// what makes the pane useful with JS disabled or still loading, and it is also
		// what makes the mismatch assertion below meaningful.
		expect(html).toContain('needs an individual decision')
		expect(errors).toEqual([])
		expect(container.textContent).toContain('What needs you')
	})

	it('renders the markdown emphasis as text rather than parsing it', async () => {
		// The model emits `**bold**`. Parsing it would mean running a markdown parser
		// over strings that already interpolate field names somebody chose.
		const { container } = await ssrThenHydrate(
			<AttentionPane attention={attention} />,
		)
		expect(container.textContent).not.toContain('**')
		expect(container.textContent).toContain(
			'`order.total` is readable by the public internet',
		)
	})

	it('shows what could not be checked, in the server markup', async () => {
		// The difference between "clean" and "not looked at". If this were
		// client-only, a maintainer with JS still loading would read an all-clear.
		const { html } = await ssrThenHydrate(
			<AttentionPane attention={attention} />,
		)
		expect(html).toContain('Not checked')
		expect(html).toContain('cannot read the filesystem')
	})

	it('names a removal in the server markup', async () => {
		const { html } = await ssrThenHydrate(
			<AttentionPane attention={attention} />,
		)
		expect(html).toContain('STOPS EXISTING')
	})

	it('hydrates cleanly with an empty report too', async () => {
		// The all-clear path renders different branches; both have to hydrate.
		const { errors, container } = await ssrThenHydrate(
			<AttentionPane
				attention={{
					report: {
						items: [],
						unavailable: [],
						headline: 'Nothing needs you.',
						pending: 0,
					},
					radius: {
						added: [],
						removed: [],
						changed: [],
						unchanged: 0,
						summary: 'no change to what gets built',
						groundingNote: 'nothing is accepted yet in: entities',
						touchesPublic: false,
					},
					exposed: [],
					latent: [],
				}}
			/>,
		)
		expect(errors).toEqual([])
		expect(container.textContent).toContain('Nothing needs you')
		// And the grounding note survives, because an unexplained empty result is the
		// thing it exists to prevent.
		expect(container.textContent).toContain('nothing is accepted yet in')
	})
})

describe('BulkReviewPane hydrates cleanly', () => {
	beforeEach(() => {
		document.body.innerHTML = ''
	})

	const proposal = (id: string, name: string, batchable: boolean) => ({
		target: { kind: 'field' as const, id, parentId: 'e-order' },
		label: name,
		state: 'suggested' as const,
		risk: {
			level: batchable ? ('low' as const) : ('high' as const),
			findings: [
				{
					level: batchable ? ('low' as const) : ('high' as const),
					reason: 'a reason',
				},
			],
			batchable,
		},
	})

	it('hydrates the mixed batchable/unbatchable group with no mismatch', async () => {
		// The interesting case for hydration: the pane renders a `<label>` wrapping a
		// checkbox for a selectable row and a plain `<div>` for a refused one, so the
		// element *type* differs by data. A mismatch here would strand the checkboxes.
		const { errors, html } = await ssrThenHydrate(
			<BulkReviewPane
				bulk={{
					proposals: [
						proposal('fld-a', 'alpha', true),
						proposal('fld-role', 'viewerRole', false),
					],
					groups: [
						{
							key: 'field:e-order',
							kind: 'field',
							parentId: 'e-order',
							label: 'fields on e-order',
							targets: [
								{ kind: 'field', id: 'fld-a', parentId: 'e-order' },
								{ kind: 'field', id: 'fld-role', parentId: 'e-order' },
							],
							assessments: [
								proposal('fld-a', 'alpha', true).risk,
								proposal('fld-role', 'viewerRole', false).risk,
							],
							risk: 'high',
							batchable: false,
							batchableCount: 1,
						},
					],
					needsAttention: [proposal('fld-role', 'viewerRole', false)],
					undoable: { batchId: 'batch-1', size: 3 },
					undoWithheld: null,
				}}
			/>,
		)
		expect(errors).toEqual([])
		// One checkbox, not two: the refused row has no control at all.
		expect(html.match(/type="checkbox"/g) ?? []).toHaveLength(1)
	})
})

describe('IntentPane hydrates cleanly', () => {
	beforeEach(() => {
		document.body.innerHTML = ''
	})

	// The first thing on the page and the only pane on it that writes, so a
	// stranded subtree here is a form that looks live and submits nothing.
	it('hydrates the empty state — the question, and a form to answer it', async () => {
		const { errors, container } = await ssrThenHydrate(
			<IntentPane view={{ intents: [], yoursCount: 0 }} />,
		)
		expect(errors).toEqual([])
		expect(container.textContent).toContain('What are you trying to build?')
		expect(container.querySelector('textarea[name="story"]')).not.toBeNull()
		// The action dispatches on this, so its absence is a silent no-op.
		expect(
			container.querySelector('input[name="intent"]')?.getAttribute('value'),
		).toBe('record-intent')
	})

	it('hydrates a recorded intent and hands it to the agent by id', async () => {
		const { errors, container } = await ssrThenHydrate(
			<IntentPane
				view={{
					intents: [
						{
							id: 'r-log-client-visits',
							story: 'a place to log client visits',
							yours: true,
							at: '2026-07-31',
						},
					],
					yoursCount: 1,
				}}
			/>,
		)
		expect(errors).toEqual([])
		// The id, not a second copy of the prose: the spec holds the sentence, and
		// the handoff points at it so the two cannot drift.
		expect(container.textContent).toContain('r-log-client-visits')
		expect(container.textContent).toContain(
			'read requirement r-log-client-visits',
		)
	})
})

describe('ReviewCostPane hydrates cleanly', () => {
	beforeEach(() => {
		document.body.innerHTML = ''
	})

	it('hydrates the inline SVG sparkline with no mismatch', async () => {
		// An SVG built from numbers is a classic hydration hazard: any float
		// formatting that differs between the server and the client shows up as a
		// mismatched `d`/`points` attribute.
		const { errors, html } = await ssrThenHydrate(
			<ReviewCostPane
				cost={{
					enabled: true,
					mode: 'local',
					report: {
						decisions: [],
						summary: {
							decisions: 3,
							proposals: 14,
							engagedMsPerProposal: 9012.345678,
							medianEngagedMsPerProposal: 1060,
							totalEngagedMs: 126_172,
							meanElapsedMs: null,
							elapsedKnown: 0,
							byOutcome: { accept: 2, reject: 1, resolve: 0 },
							byMode: { individual: 2, bulk: 12 },
							idleCutoffMs: 120_000,
						},
						curve: [
							{
								n: 1,
								cumulativeEngagedMsPerProposal: 5000,
								engagedMsPerProposal: 5000,
								mode: 'individual',
								at: '2026-07-29T10:00:00.000Z',
							},
							{
								n: 13,
								cumulativeEngagedMsPerProposal: 9012.345678,
								engagedMsPerProposal: 1000.3333,
								mode: 'bulk',
								at: '2026-07-29T10:02:00.000Z',
							},
						],
					},
				}}
			/>,
		)
		expect(errors).toEqual([])
		expect(html).toContain('<svg')
	})

	it('hydrates the opted-out state', async () => {
		const { errors, container } = await ssrThenHydrate(
			<ReviewCostPane cost={{ enabled: false, mode: 'off' }} />,
		)
		expect(errors).toEqual([])
		// Absent, not zero — a zero would read as "review is free".
		expect(container.textContent).not.toMatch(/\b0\.0s\b/)
	})
})
