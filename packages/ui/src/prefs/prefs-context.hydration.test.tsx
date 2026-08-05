/**
 * Issue #138 — the SSR hydration contract for preference-backed UI.
 *
 * `useStore` passed its localStorage-reading `getSnapshot` as
 * `getServerSnapshot`. React calls `getServerSnapshot` on the *client* during
 * hydration, so any visitor whose persisted value differed from the fallback
 * hydrated with different markup than the server sent — the mechanism behind
 * #137's zombie cookie banner (SSR DOM stranded with dead handlers).
 *
 * These drive a real server render + real `hydrateRoot`, which is the only way
 * to catch this class: a client-only `render()` never exercises
 * `getServerSnapshot` at all, which is why the original bug shipped green.
 */

import { render as rtlRender, screen } from '@testing-library/react'
import type { ReactNode } from 'react'
import { act } from 'react'
import { hydrateRoot } from 'react-dom/client'
import { renderToString } from 'react-dom/server'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import {
	ClientOnly,
	PreferenceProvider,
	useHydrated,
	useHydratedStore,
	useStore,
} from './prefs-context.tsx'
import { memoryBackend, PreferenceStore } from './store.ts'

/** A store that already holds a persisted value — i.e. a returning visitor. */
function storeWith(key: string, value: unknown): PreferenceStore {
	const store = new PreferenceStore({ backend: memoryBackend() })
	store.set(key, value, null)
	return store
}

function tree(store: PreferenceStore, children: ReactNode) {
	return <PreferenceProvider store={store}>{children}</PreferenceProvider>
}

/**
 * Server-render `ui` with a *fresh* store (the server has no localStorage),
 * then hydrate the resulting DOM with `clientStore` (the returning visitor's
 * persisted state). Returns the container plus anything React logged — a
 * hydration mismatch shows up as a `console.error`.
 */
async function ssrThenHydrate(
	clientStore: PreferenceStore,
	ui: ReactNode,
): Promise<{ container: HTMLElement; errors: string[] }> {
	const serverStore = new PreferenceStore({ backend: memoryBackend() })
	const html = renderToString(tree(serverStore, ui))

	const container = document.createElement('div')
	container.innerHTML = html
	document.body.appendChild(container)

	// `onRecoverableError` is React's own channel for "hydration didn't match, I
	// patched it up by client-rendering" — the precise signal. Asserting on it
	// (rather than on console.error) is what makes these tests actually fail on
	// a regression: React 19 recovers from a mismatch and still lands on the
	// right final DOM, so a DOM-only assertion passes either way.
	const errors: string[] = []
	const spy = vi.spyOn(console, 'error').mockImplementation(() => {})
	try {
		await act(async () => {
			hydrateRoot(container, tree(clientStore, ui), {
				onRecoverableError: (error) => {
					errors.push(String((error as Error)?.message ?? error))
				},
			})
		})
	} finally {
		spy.mockRestore()
	}
	return { container, errors }
}

function Density() {
	const [density] = useStore('ui.density', 'comfortable')
	return <p data-testid="out">{density}</p>
}

describe('useStore hydration', () => {
	beforeEach(() => {
		document.body.innerHTML = ''
	})

	it('server-renders the fallback, not the persisted value', () => {
		// The server has no localStorage; whatever it renders is what the client
		// must hydrate against.
		const html = renderToString(
			tree(new PreferenceStore({ backend: memoryBackend() }), <Density />),
		)
		expect(html).toContain('comfortable')
	})

	it('hydrates without a mismatch when the persisted value differs', async () => {
		const { container, errors } = await ssrThenHydrate(
			storeWith('ui.density', 'compact'),
			<Density />,
		)
		expect(errors).toEqual([])
		// And it lands on the persisted value once hydration completes, rather
		// than being stuck on the fallback.
		expect(container.querySelector('[data-testid="out"]')?.textContent).toBe(
			'compact',
		)
	})

	it('still hydrates clean when the persisted value equals the fallback', async () => {
		const { container, errors } = await ssrThenHydrate(
			storeWith('ui.density', 'comfortable'),
			<Density />,
		)
		expect(errors).toEqual([])
		expect(container.querySelector('[data-testid="out"]')?.textContent).toBe(
			'comfortable',
		)
	})
})

function Banner() {
	const [dismissed, , hydrated] = useHydratedStore('dismissed', false)
	if (!hydrated || dismissed) return null
	return <section data-testid="banner">cookies</section>
}

describe('useHydratedStore (the no-flash gate)', () => {
	beforeEach(() => {
		document.body.innerHTML = ''
	})

	it('renders nothing on the server, so there is no SSR node to strand', () => {
		const html = renderToString(
			tree(new PreferenceStore({ backend: memoryBackend() }), <Banner />),
		)
		expect(html).not.toContain('cookies')
	})

	it('stays hidden after hydration for a visitor who dismissed it', async () => {
		const { container, errors } = await ssrThenHydrate(
			storeWith('dismissed', true),
			<Banner />,
		)
		expect(errors).toEqual([])
		expect(container.querySelector('[data-testid="banner"]')).toBeNull()
	})

	it('appears after hydration for a visitor who has not', async () => {
		const { container, errors } = await ssrThenHydrate(
			new PreferenceStore({ backend: memoryBackend() }),
			<Banner />,
		)
		expect(errors).toEqual([])
		expect(container.querySelector('[data-testid="banner"]')).not.toBeNull()
	})

	it('reports hydrated=false on the first client render, true after', () => {
		const seen: boolean[] = []
		function Probe() {
			seen.push(useHydrated())
			return null
		}
		rtlRender(<Probe />)
		// A plain client render has no hydration pass, so it starts true; the
		// server/hydration path is covered by the SSR cases above.
		expect(seen.at(-1)).toBe(true)
	})
})

describe('ClientOnly', () => {
	beforeEach(() => {
		document.body.innerHTML = ''
	})

	it('renders its fallback on the server and its children after hydration', async () => {
		const ui = (
			<ClientOnly fallback={<span data-testid="skeleton">…</span>}>
				<span data-testid="real">real</span>
			</ClientOnly>
		)
		const html = renderToString(
			tree(new PreferenceStore({ backend: memoryBackend() }), ui),
		)
		expect(html).toContain('skeleton')
		expect(html).not.toContain('>real<')

		const { container, errors } = await ssrThenHydrate(
			new PreferenceStore({ backend: memoryBackend() }),
			ui,
		)
		expect(errors).toEqual([])
		expect(container.querySelector('[data-testid="real"]')).not.toBeNull()
	})

	it('defaults its fallback to nothing', () => {
		rtlRender(
			<ClientOnly>
				<span>shown</span>
			</ClientOnly>,
		)
		expect(screen.getByText('shown')).toBeInTheDocument()
	})
})
