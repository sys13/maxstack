/**
 * @vitest-environment jsdom
 *
 * The "Under the hood" disclosure.
 *
 * The change under test is that eight introspection folds are no longer computed
 * on every request to be rendered inside an element nobody opened. What has to
 * stay true while that is the case is the whole reason the first pass left it
 * alone:
 *
 *   - closed does not mean **gone** — the eight are named where a reader can see
 *     that this surface can answer them;
 *   - open is a **URL**, so the state survives a reload and a shared link, and both
 *     states are a plain server render rather than a client-side fetch;
 *   - toggling keeps the rest of the address, because losing the focused node on
 *     the way into diagnostics is how somebody ends up with two tabs.
 */

import type { ReactNode } from 'react'
import { renderToString } from 'react-dom/server'
import { createRoutesStub } from 'react-router'
import { describe, expect, it } from 'vitest'
import { DIAGNOSTIC_FOLDS, Diagnostics, underTheHoodHref } from './diagnostics'

function dom(ui: ReactNode): HTMLElement {
	const Stub = createRoutesStub([{ path: '/', Component: () => <>{ui}</> }])
	const el = document.createElement('div')
	el.innerHTML = renderToString(<Stub initialEntries={['/']} />)
	return el
}

const CHILD = <p data-testid="fold">a diagnostic fold</p>

describe('closed', () => {
	const el = dom(
		<Diagnostics open={false} params={new URLSearchParams()}>
			{CHILD}
		</Diagnostics>,
	)

	it('renders none of the panes', () => {
		// The loader hands `null` when the param is absent, so this is what a reader
		// gets — and the point of the change is that nothing was computed for it.
		expect(el.querySelector('[data-testid="fold"]')).toBeNull()
	})

	it('still says what it hides, by name', () => {
		for (const fold of DIAGNOSTIC_FOLDS)
			expect(el.textContent).toContain(fold.title)
	})

	it('offers a link, not a client-side toggle', () => {
		const link = el.querySelector('a')
		expect(link?.getAttribute('href')).toContain('under-the-hood=1')
		expect(el.querySelector('details')).toBeNull()
	})
})

describe('open', () => {
	const el = dom(
		<Diagnostics open params={new URLSearchParams({ 'under-the-hood': '1' })}>
			{CHILD}
		</Diagnostics>,
	)

	it('renders the panes it was given', () => {
		expect(el.querySelector('[data-testid="fold"]')).not.toBeNull()
	})

	it('offers the way back out', () => {
		expect(el.querySelector('a')?.getAttribute('href')).not.toContain(
			'under-the-hood',
		)
	})
})

describe('the href keeps the rest of the address', () => {
	const params = new URLSearchParams({ focus: 'e-order', queue: 'product' })

	it('adds the flag without dropping the focused node', () => {
		const href = underTheHoodHref(params, true)
		expect(href).toContain('focus=e-order')
		expect(href).toContain('queue=product')
		expect(href).toContain('under-the-hood=1')
	})

	it('removes only the flag', () => {
		const href = underTheHoodHref(
			new URLSearchParams({
				...Object.fromEntries(params),
				'under-the-hood': '1',
			}),
			false,
		)
		expect(href).toContain('focus=e-order')
		expect(href).not.toContain('under-the-hood')
	})
})
