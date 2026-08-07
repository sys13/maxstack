/**
 * @vitest-environment jsdom
 *
 * The error page as a browser receives it (#339).
 *
 * Server markup rather than a client-only render, for the reason
 * `describe-prefill.hydration.test.tsx` gives: the whole complaint in #339 is
 * about what is in the first byte — a themed page with the app's nav, or two
 * lines of monospace. Assertions read `renderToString` output.
 */

import { DEFAULT_THEME } from '@maxstack/spec'
import { renderToString } from 'react-dom/server'
import { createRoutesStub, UNSAFE_ErrorResponseImpl } from 'react-router'
import { describe, expect, it } from 'vitest'
import { ErrorPage, presentError } from './error-page'
import type { ProjectShell } from './project.server'

const shell: ProjectShell = {
	title: 'Reader',
	theme: DEFAULT_THEME,
	pages: [
		{ slug: 'books', name: 'Books' },
		{ slug: 'shelves', name: 'Shelves' },
	],
}

function render(node: React.ReactNode): string {
	// `Link`/`NavLink`/`useRevalidator` all need a router on the server too.
	const Stub = createRoutesStub([{ path: '/', Component: () => <>{node}</> }])
	return renderToString(<Stub initialEntries={['/']} />)
}

function notFound(path: string) {
	return presentError(
		new UNSAFE_ErrorResponseImpl(404, 'Not Found', { error: 'Unknown page' }),
		{ dev: false, path },
	)
}

describe('<ErrorPage>', () => {
	it('renders a 404 inside the app chrome, with the nav and a way back', () => {
		const html = render(
			<ErrorPage presented={notFound('/nonsense')} shell={shell} />,
		)
		expect(html).toContain('Page not found')
		expect(html).toContain('/nonsense')
		// The app still looks like the app: its name, its nav, its theme scope.
		expect(html).toContain('Reader')
		expect(html).toContain('Books')
		expect(html).toContain('mx-theme')
		expect(html).toContain('Go home')
		// A wrong address is not something to retry.
		expect(html).not.toContain('Try again')
	})

	it('falls back to the chrome-less page when the root loader left no shell', () => {
		const html = render(
			<ErrorPage presented={notFound('/nonsense')} shell={null} />,
		)
		expect(html).toContain('Page not found')
		expect(html).toContain('Go home')
		// No nav to render, and no claim that there is one.
		expect(html).not.toContain('Books')
	})

	it('shows a 500 as a quotable id, offers a retry, and prints no message', () => {
		const presented = presentError(
			new Error('select "book"."secret_token" from "book"'),
			{ dev: false },
		)
		const withId = { ...presented, errorId: 'err_abc123' }
		const html = render(<ErrorPage presented={withId} shell={shell} />)
		expect(html).toContain('err_abc123')
		expect(html).toContain('Try again')
		expect(html).not.toContain('secret_token')
	})
})
