/**
 * @vitest-environment jsdom
 *
 * Issue #282's second half, which landed without a test.
 *
 * The consent bar is `position: fixed`, so it sits over the bottom strip of the
 * viewport — and on a form long enough to scroll, that strip is the submit
 * button. The reporter clicked "Create" twice on a filled-in form with nothing
 * happening before noticing the click was landing on the bar; a user who does
 * not scroll past it concludes the form is broken.
 *
 * The fix is not padding on that one form. The bar reserves its own space in
 * the flow: an in-flow spacer sibling as tall as the bar, appended after the
 * routed content at the document level, so the document's scrollable height
 * grows by exactly the strip the bar covers. Scrolled to the bottom, the last
 * content pixel then lands on the bar's top edge rather than behind it — for
 * *every* page, including ones written after this bar existed.
 *
 * The height is measured rather than a constant because the bar wraps to two
 * rows on a narrow viewport, and a hardcoded height is wrong at exactly the
 * width where getting it wrong costs the most.
 *
 * jsdom lays nothing out, so these assert the structure that makes the geometry
 * hold — the spacer exists, tracks the measured height, is `aria-hidden`
 * (it is layout, not a second copy of the disclosure for a screen reader), and
 * gives the space back when the bar goes away — plus #137's property, that
 * neither element is in the server markup, so nothing flashes for someone who
 * already dismissed it.
 */

import type { ReactNode } from 'react'
import { act } from 'react'
import { hydrateRoot } from 'react-dom/client'
import { renderToString } from 'react-dom/server'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { CookieConsentBanner } from './cookie-consent-banner'

/** What the bar currently measures, as `offsetHeight` would report it. */
let barHeight = 57
/** Every live `ResizeObserver` callback, so a test can fire a re-measure. */
let resizeCallbacks: Array<() => void> = []

class FakeResizeObserver {
	constructor(callback: () => void) {
		resizeCallbacks.push(callback)
	}
	observe(): void {}
	unobserve(): void {}
	disconnect(): void {}
}

beforeEach(() => {
	barHeight = 57
	resizeCallbacks = []
	localStorage.clear()
	vi.stubGlobal('ResizeObserver', FakeResizeObserver)
	// jsdom reports 0 for every box. The bar is the only element the component
	// measures, so give that one a height and leave the rest at zero — a spacer
	// that read its own height instead would silently pass at 0.
	Object.defineProperty(HTMLElement.prototype, 'offsetHeight', {
		configurable: true,
		get(this: HTMLElement) {
			return this.tagName === 'SECTION' ? barHeight : 0
		},
	})
})

afterEach(() => {
	vi.unstubAllGlobals()
	// The prototype must come back with the property *gone*, not present and
	// undefined — jsdom's own getter has to be the one that answers again.
	delete (HTMLElement.prototype as { offsetHeight?: unknown }).offsetHeight
	document.body.innerHTML = ''
})

/** Server-render `ui`, then hydrate the same tree over that markup — the shape
 * `describe-prefill.hydration.test.tsx` established after issue #138. */
async function ssrThenHydrate(
	ui: ReactNode,
): Promise<{ container: HTMLElement; html: string }> {
	const html = renderToString(ui)
	const container = document.createElement('div')
	container.innerHTML = html
	document.body.appendChild(container)
	await act(async () => {
		hydrateRoot(container, ui)
	})
	return { container, html }
}

const bar = (c: HTMLElement) =>
	c.querySelector('section[aria-label="Cookie consent"]')
const spacer = (c: HTMLElement) =>
	c.querySelector<HTMLElement>('[data-testid="cookie-banner-spacer"]')

describe('cookie consent bar layout (#282)', () => {
	it('is absent from the server markup — nothing flashes before the gate (#137)', async () => {
		const { html } = await ssrThenHydrate(<CookieConsentBanner />)
		expect(html).not.toContain('Cookie consent')
		expect(html).not.toContain('cookie-banner-spacer')
	})

	it('reserves an in-flow strip as tall as the bar, ahead of it in the flow', async () => {
		const { container } = await ssrThenHydrate(<CookieConsentBanner />)
		const strip = spacer(container)
		expect(bar(container)).not.toBeNull()
		expect(strip).not.toBeNull()
		// The measured height, not a guess: a 0 here is the overlap bug back.
		expect(strip?.style.height).toBe('57px')
		// Layout, not content — a screen reader must not meet the disclosure twice.
		expect(strip?.getAttribute('aria-hidden')).not.toBeNull()
		// Ahead of the fixed bar in document order, so it lengthens the page the
		// bar covers rather than trailing off the end of it.
		expect(strip?.compareDocumentPosition(bar(container) as Node)).toBe(
			Node.DOCUMENT_POSITION_FOLLOWING,
		)
	})

	it('grows with the bar when it wraps to two rows on a narrow viewport', async () => {
		const { container } = await ssrThenHydrate(<CookieConsentBanner />)
		expect(spacer(container)?.style.height).toBe('57px')
		barHeight = 96
		await act(async () => {
			for (const fire of resizeCallbacks) fire()
		})
		expect(spacer(container)?.style.height).toBe('96px')
	})

	it('gives the strip back when the bar is dismissed', async () => {
		const { container } = await ssrThenHydrate(<CookieConsentBanner />)
		const dismiss = [...container.querySelectorAll('button')].find(
			(b) => b.textContent === 'Dismiss',
		)
		await act(async () => {
			dismiss?.click()
		})
		expect(bar(container)).toBeNull()
		expect(spacer(container)).toBeNull()
	})
})
