/**
 * @vitest-environment jsdom
 *
 * No list on this surface may be keyed by a value.
 *
 * #243 reported four `Encountered two children with the same key` errors on
 * `/workbench` and said outright that the source was never identified. It could
 * not be reproduced against today's tree — #256 rebuilt the page, and the dogfood
 * project's telemetry log has exactly one same-millisecond collision, outside the
 * window the pane renders. So this does not chase those four. It removes the
 * *class*, and fails on it in future.
 *
 * The class: a key that is a **value** rather than an **identity**. A label, a
 * bullet string, a file path, a timestamp — each is unique in the data somebody
 * had in front of them, and none is unique by construction:
 *
 *   - `key={e.at}` on the activity log. `at` is a wall-clock ISO string, and the
 *     loader records `view` and `focus` in the same tick, so two events an
 *     instant apart share it. There is one such pair in a real project.
 *   - `key={r.label}` on the detail rows, `key={c}` on acceptance criteria,
 *     `key={step}` on an upgrade chain — repeated text is not a bug in the data,
 *     it is text.
 *
 * Why it matters more than a console warning: React reuses or discards the wrong
 * child, so a list can render stale content after an update. On this surface the
 * lists are *proposals a human is deciding about*, which is the worst place for a
 * row to show the wrong thing — and, like #138, it is invisible to a client-only
 * `render()` that never looks at the console.
 *
 * Every case below feeds each pane data whose values genuinely repeat, which is
 * the input a real project eventually produces and no fixture ever did.
 */

import type { ReactNode } from 'react'
import { act } from 'react'
import { createRoot } from 'react-dom/client'
import { createRoutesStub } from 'react-router'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { AttentionPane } from './attention-pane'
import { ActivityPane, DetailPane } from './detail-panes'
import { FlagsPane } from './flags-pane'
import { ModulesPane } from './modules-pane'

let errors: string[] = []

beforeEach(() => {
	errors = []
	vi.spyOn(console, 'error').mockImplementation((...args: unknown[]) => {
		errors.push(args.map(String).join(' '))
	})
})
afterEach(() => vi.restoreAllMocks())

/**
 * Client-render the pane.
 *
 * A **client** render, deliberately, even though these panes are server-rendered
 * by design: `renderToString` does not emit the duplicate-key warning at all — it
 * is a reconciliation check, and the server never reconciles. A version of this
 * file written against `renderToString` passed every case while the bug was
 * present, which is worth stating because it is the same shape as #138 (a
 * client-only `render()` cannot catch a hydration mismatch; a server-only render
 * cannot catch this).
 */
function render(ui: ReactNode): void {
	const Stub = createRoutesStub([{ path: '/', Component: () => <>{ui}</> }])
	const container = document.createElement('div')
	document.body.appendChild(container)
	act(() => {
		createRoot(container).render(<Stub initialEntries={['/']} />)
	})
	// `act` + `createRoot` report a throw during render to `console.error` and
	// carry on, so a fixture whose shape does not match the pane's props renders
	// nothing and every key assertion below passes for the wrong reason. Three of
	// these did exactly that while being written.
	const crashed = errors.filter((e) =>
		/TypeError|is not a function|^Error/.test(e),
	)
	expect(crashed.join('\n')).toBe('')
	expect(container.textContent?.length ?? 0).toBeGreaterThan(0)
}

/** The assertion, with the offending message quoted rather than a bare boolean. */
function expectNoDuplicateKeys(): void {
	const dup = errors.filter((e) => /same key/.test(e))
	expect(dup.join('\n')).toBe('')
}

describe('the detector itself', () => {
	it('sees a duplicate key when there is one', () => {
		// Without this, every assertion below is satisfied by a spy that never
		// receives anything — a green suite that checks nothing, which is the exact
		// failure mode #243 is about (four warnings nobody's tests could see).
		render(
			<ul>
				{['a', 'a'].map((v) => (
					<li key={v}>{v}</li>
				))}
			</ul>,
		)
		expect(errors.filter((e) => /same key/.test(e))).toHaveLength(1)
	})
})

describe('the activity log survives two events in one millisecond', () => {
	it('keys by more than the timestamp', () => {
		const at = '2026-07-31T10:00:00.000Z'
		render(
			<ActivityPane
				telemetry={{
					summary: {
						total: 3,
						byKind: { accept: 0, reject: 0, resolve: 0, focus: 2, view: 1 },
					},
					// Exactly what the loader writes: `view` then `focus`, same tick.
					recent: [
						{ at, kind: 'view' },
						{ at, kind: 'focus', targetId: 'e-order' },
						{ at, kind: 'focus', targetId: 'e-order' },
					],
				}}
			/>,
		)
		expectNoDuplicateKeys()
	})
})

describe('a detail pane survives repeated text', () => {
	it('keys rows and criteria by more than their words', () => {
		render(
			<DetailPane
				detail={{
					id: 'e-order',
					kind: 'entity',
					title: 'Order',
					state: 'suggested',
					rows: [
						{ label: 'total', state: 'accepted' },
						// Two fields can carry the same label — a field on the entity and
						// a column on the page, say. The DOM does not care; React does.
						{ label: 'total', state: 'suggested' },
					],
					derivedPages: [{ label: 'Orders' }, { label: 'Orders' }],
					acceptanceCriteria: ['it works', 'it works'],
				}}
				history={[]}
				preview={[
					{ path: 'app/orders.tsx', content: 'x' },
					{ path: 'app/orders.tsx', content: 'y' },
				]}
				previewNotes={['note', 'note']}
				previewHtml={null}
				previewError={null}
			/>,
		)
		expectNoDuplicateKeys()
	})
})

describe('the flags and modules panes survive repeated reasons', () => {
	it('keys a stale-reason list by more than the reason', () => {
		render(
			<FlagsPane
				all={[
					{
						key: 'beta',
						description: 'beta things',
						ageDays: 90,
						gates: 0,
						lastEvaluatedAt: null,
						evaluations: 0,
						reasons: ['gates-nothing', 'gates-nothing'],
					},
				]}
				stale={[]}
			/>,
		)
		expectNoDuplicateKeys()
	})

	it('keys a module contribution list by more than the line', () => {
		render(
			<ModulesPane
				modules={[
					{
						slug: 'billing',
						title: 'Billing',
						description: 'money',
						version: '2.0.0',
						prerequisites: [],
						requires: [],
						contributes: ['a table', 'a table'],
						uninstallable: false,
						installed: {
							version: '1.0.0',
							upgradeTo: '2.0.0',
							upgradeSteps: ['bump', 'bump'],
						},
					},
				]}
			/>,
		)
		expectNoDuplicateKeys()
	})
})

describe('the attention pane survives two items about one surface', () => {
	it('keys items by more than the report id', () => {
		// `exposureItems` derives its id from the surface, and reads both
		// `effect.added` and `effect.changed` — one surface reachable through both
		// produces two items with one id.
		const item = {
			kind: 'public-change' as const,
			id: 'attention:public-field:order.total',
			title: '`order.total` is public',
			because: 'it cannot be undone',
			where: null,
		}
		render(
			<AttentionPane
				attention={{
					report: {
						items: [item, { ...item }],
						unavailable: ['drift', 'drift'],
						headline: 'Two changes would put data on the public internet.',
						pending: 2,
					},
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
				}}
			/>,
		)
		expectNoDuplicateKeys()
	})
})
