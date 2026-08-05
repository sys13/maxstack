/**
 * @vitest-environment jsdom
 *
 * `<Timestamp>` hydrates without a mismatch.
 *
 * The test has to drive a **real `renderToString` then a real `hydrateRoot`**, and
 * assert on `onRecoverableError`. Every weaker version of this test passes while
 * the bug is present:
 *
 *   - a client-only `render()` never produces a server snapshot, so there is
 *     nothing to disagree with (this is #138's lesson, restated);
 *   - a DOM assertion passes either way, because React recovers from a mismatch by
 *     client-rendering the subtree and landing on correct-looking markup.
 *
 * `onRecoverableError` is React's own "hydration did not match, I patched it up"
 * channel, and it is the only signal that separates the two.
 *
 * The suite pins its own sensitivity first: a component that formats with
 * `toLocaleString()` under a non-default `TZ` **must** trip the detector, or the
 * clean results below prove nothing.
 */

import type { ReactNode } from 'react'
import { act } from 'react'
import { hydrateRoot } from 'react-dom/client'
import { renderToString } from 'react-dom/server'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { Timestamp, utcStamp } from './timestamp.tsx'

const ISO = '2026-07-08T20:00:00.000Z'

async function ssrThenHydrate(ui: ReactNode): Promise<{
	html: string
	container: HTMLElement
	errors: string[]
}> {
	const html = renderToString(ui)
	const container = document.createElement('div')
	container.innerHTML = html
	document.body.appendChild(container)

	const errors: string[] = []
	const spy = vi.spyOn(console, 'error').mockImplementation(() => {})
	try {
		await act(async () => {
			hydrateRoot(container, ui, {
				onRecoverableError: (error) =>
					errors.push(String((error as Error)?.message ?? error)),
			})
		})
	} finally {
		spy.mockRestore()
	}
	return { html, container, errors }
}

beforeEach(() => {
	document.body.innerHTML = ''
})
afterEach(() => vi.restoreAllMocks())

describe('the detector is sensitive to the bug', () => {
	it('trips on a component that formats with the runtime locale', async () => {
		// The shape of all eight sites #267 lists. Rendering the *server* string with
		// a different zone than the client is what actually happens in production
		// (a UTC container, a viewer in Toronto), and is simulated here by rendering
		// the two halves from different formatters.
		function Naive({ first }: { first: boolean }) {
			const d = new Date(ISO)
			return (
				<time dateTime={ISO}>
					{first
						? d.toLocaleString('en-CA', { timeZone: 'UTC' })
						: d.toLocaleString('en-US', { timeZone: 'America/Toronto' })}
				</time>
			)
		}
		const html = renderToString(<Naive first={true} />)
		const container = document.createElement('div')
		container.innerHTML = html
		document.body.appendChild(container)
		const errors: string[] = []
		const spy = vi.spyOn(console, 'error').mockImplementation(() => {})
		try {
			await act(async () => {
				hydrateRoot(container, <Naive first={false} />, {
					onRecoverableError: (e) =>
						errors.push(String((e as Error)?.message ?? e)),
				})
			})
		} finally {
			spy.mockRestore()
		}
		expect(errors.join('\n')).toMatch(/did not match|Hydration/i)
	})
})

describe('<Timestamp> hydrates clean', () => {
	it('server-renders the deterministic form and hydrates with no mismatch', async () => {
		const { html, errors } = await ssrThenHydrate(<Timestamp iso={ISO} />)
		// The server markup carries the runtime-independent string, so the first
		// client paint can match it whatever the viewer's locale is.
		expect(html).toContain(utcStamp(ISO))
		expect(html).toContain('2026-07-08 20:00:00 UTC')
		expect(errors).toEqual([])
	})

	it('keeps the machine-readable instant in dateTime, in both states', async () => {
		const { html, container } = await ssrThenHydrate(<Timestamp iso={ISO} />)
		expect(html).toContain(`dateTime="${ISO}"`)
		expect(container.querySelector('time')?.getAttribute('datetime')).toBe(ISO)
	})

	it('upgrades to the viewer’s locale after mount', async () => {
		const { container } = await ssrThenHydrate(<Timestamp iso={ISO} />)
		// Whatever this runner's locale is, the post-hydration text is its own
		// rendering rather than the UTC placeholder.
		expect(container.textContent).toBe(new Date(ISO).toLocaleString())
	})

	it('hydrates an unparseable value without inventing one', async () => {
		const { html, errors, container } = await ssrThenHydrate(
			<Timestamp iso="not-a-date" />,
		)
		expect(errors).toEqual([])
		expect(html).toContain('not-a-date')
		expect(container.textContent).toBe('not-a-date')
	})

	it('honours a custom format without breaking hydration', async () => {
		const { errors, container } = await ssrThenHydrate(
			<Timestamp iso={ISO} format={(v) => `at ${v}`} />,
		)
		// The override applies to the local rendering only — the server half stays
		// deterministic, which is what makes the custom formatter safe to pass.
		expect(errors).toEqual([])
		expect(container.textContent).toBe(`at ${ISO}`)
	})
})
