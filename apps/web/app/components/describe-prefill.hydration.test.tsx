/**
 * @vitest-environment jsdom
 *
 * The describe panel is gone — in the *server* markup — when no AI provider is
 * configured.
 *
 * Why server-rendered rather than a client-only `render()`: the whole point of
 * the fix is that the answer is in the first byte the browser receives, not in
 * a fetcher response the user reaches by typing a description first. A
 * client-only render cannot tell those apart — both end up with the same DOM
 * once effects have run. So every assertion here reads `renderToString` output,
 * and the available case is then really hydrated, in the shape
 * `workbench/panes.hydration.test.tsx` established after issue #138.
 *
 * The dictate button gets its own case because it is the one control that
 * needed no server at all: Web Speech transcribes in-browser, so before this
 * fix it would happily record and strand a transcript in a box whose only
 * consumer was unreachable.
 */

import type { ReactNode } from 'react'
import { act } from 'react'
import { hydrateRoot } from 'react-dom/client'
import { renderToString } from 'react-dom/server'
import { createRoutesStub } from 'react-router'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { DescribePrefill } from './describe-prefill'

/** Server-render `ui`, then hydrate the same tree over that markup. */
async function ssrThenHydrate(
	ui: ReactNode,
): Promise<{ container: HTMLElement; errors: string[]; html: string }> {
	// `useFetcher` needs a router context on both sides.
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

/** A Web Speech constructor, so the dictate button is offered when it can be. */
class FakeRecognition {
	continuous = false
	interimResults = false
	lang = ''
	started = false
	onresult = null
	onerror = null
	onend = null
	start() {
		this.started = true
		constructed.push(this)
	}
	stop() {}
}
let constructed: FakeRecognition[] = []

describe('DescribePrefill availability', () => {
	beforeEach(() => {
		document.body.innerHTML = ''
		constructed = []
		;(window as unknown as Record<string, unknown>).webkitSpeechRecognition =
			FakeRecognition
	})
	afterEach(() => {
		;(window as unknown as Record<string, unknown>).webkitSpeechRecognition =
			undefined
	})

	it('renders nothing at all when no AI provider is configured', async () => {
		const { html, container, errors } = await ssrThenHydrate(
			<DescribePrefill
				action="/things/parse"
				onFields={() => {}}
				available={false}
			/>,
		)
		// Not "renders but disabled": no label to read, no textarea to type into,
		// no button to press. The form below is the source of truth either way.
		expect(html).not.toContain('Describe it')
		expect(html).not.toContain('<textarea')
		expect(container.querySelector('textarea')).toBeNull()
		expect(container.textContent).not.toContain('Fill the form')
		expect(errors).toEqual([])
	})

	it('offers no dictation when the panel is unavailable, even though Web Speech is local', async () => {
		const { container } = await ssrThenHydrate(
			<DescribePrefill
				action="/things/parse"
				onFields={() => {}}
				available={false}
			/>,
		)
		// The button is added by an effect after mount, so this is only meaningful
		// post-hydration — and it is the case that used to record a user's voice
		// into a box nothing could consume.
		expect(container.textContent).not.toContain('Dictate')
		expect(constructed).toEqual([])
	})

	it('server-renders the panel when a provider is configured, and hydrates cleanly', async () => {
		const { html, container, errors } = await ssrThenHydrate(
			<DescribePrefill
				action="/things/parse"
				onFields={() => {}}
				available={true}
			/>,
		)
		expect(html).toContain('Describe it')
		expect(html).toContain('<textarea')
		expect(errors).toEqual([])
		expect(container.textContent).toContain('Fill the form')
		// Feature detection is deliberately post-mount (the server cannot know), so
		// the button appears only after hydration — which is exactly why it must
		// not be the thing that decides whether the panel is offered.
		expect(container.textContent).toContain('Dictate')
	})

	it('switches the copy for an edit form, still server-side', async () => {
		const { html } = await ssrThenHydrate(
			<DescribePrefill
				action="/things/parse"
				onFields={() => {}}
				available={true}
				existing={{ id: 'r-1', status: 'todo' }}
				keepOnReplace={['id']}
			/>,
		)
		expect(html).toContain('Describe the change')
		expect(html).toContain('Keep the fields it does not mention')
	})

	it('keeps the button row from being squeezed by a long status', async () => {
		// `flex items-center` alone let a long status string compress its siblings
		// instead of wrapping, folding "Fill the form" into three stacked words.
		const { container } = await ssrThenHydrate(
			<DescribePrefill
				action="/things/parse"
				onFields={() => {}}
				available={true}
			/>,
		)
		const button = container.querySelector('button')
		expect(button?.className).toContain('shrink-0')
		expect(button?.parentElement?.className).toContain('flex-wrap')
	})
})
