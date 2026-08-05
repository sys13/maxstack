/**
 * The surface primitives.
 *
 * Two things are worth asserting about a set of class-string components, and
 * neither is "does it render".
 *
 * The first is the **palette constraint**: every colour these emit has to be a
 * token the theme actually defines. A `bg-info/10` that resolves to nothing
 * produces an unstyled box, not an error — it looks like a layout bug months
 * later, in whichever app first used the variant. So the class strings are
 * checked against the token list itself.
 *
 * The second is **caller override**, the property that decides whether these get
 * used at all: `cn` is `tailwind-merge`, so a caller's `className` must win over
 * the built-in. If it does not, every call site goes back to hand-rolling.
 */

import { render, screen } from '@testing-library/react'
import { describe, expect, it } from 'vitest'
import {
	Alert,
	Badge,
	Button,
	buttonVariants,
	Card,
	Separator,
	Table,
	TableBody,
	TableCell,
	TableHead,
	TableHeader,
	TableRow,
} from '../index.ts'
import { THEME_TOKEN_NAMES } from '../theme/presets.ts'

/**
 * Colour tokens the theme defines, taken from the token list itself rather than
 * retyped here. This was a hand-copied array once, and it drifted the moment the
 * palette grew `success`/`warning` — a stale allowlist fails a variant that is
 * in fact expressible, which is the same class of wrong as passing one that is
 * not. `THEME_TOKEN_NAMES` is what `themeToCss` emits and what the app
 * stylesheet declares, so a token here is a token that resolves.
 */
const TOKENS = [
	...THEME_TOKEN_NAMES,
	// CSS-wide colour keywords, which are not theme tokens but do resolve.
	'transparent',
	'current',
	'inherit',
]

/** Every colour utility in a class string, as the token it points at. */
function colorTokens(classes: string): string[] {
	const out: string[] = []
	for (const cls of classes.split(/\s+/).filter(Boolean)) {
		const m =
			/^(?:hover:|focus-visible:|dark:)*(?:bg|text|border|ring|fill)-(.+)$/.exec(
				cls,
			)
		if (!m?.[1]) continue
		const token = m[1].split('/')[0] ?? ''
		// Utilities that are not colours at all: border-b, text-sm, ring-1…
		if (
			/^\d/.test(token) ||
			[
				'b',
				't',
				'l',
				'r',
				'x',
				'y',
				'sm',
				'base',
				'lg',
				'xl',
				'xs',
				'left',
				'center',
				'right',
				'medium',
				'none',
			].includes(token)
		) {
			continue
		}
		out.push(token)
	}
	return out
}

function classesOf(el: Element | null): string {
	return el?.getAttribute('class') ?? ''
}

describe('the palette constraint', () => {
	it('names only colour tokens the theme defines', () => {
		const { container } = render(
			<div>
				<Alert variant="info">info</Alert>
				<Alert variant="success">good</Alert>
				<Alert variant="warning">careful</Alert>
				<Alert variant="destructive">bad</Alert>
				<Badge variant="default">a</Badge>
				<Badge variant="outline">b</Badge>
				<Badge variant="success">c</Badge>
				<Badge variant="warning">d</Badge>
				<Badge variant="destructive">e</Badge>
				<Badge variant="primary">f</Badge>
				<Card>card</Card>
				<Separator />
			</div>,
		)
		const unknown = new Set<string>()
		for (const el of container.querySelectorAll('*')) {
			for (const token of colorTokens(classesOf(el))) {
				if (!TOKENS.includes(token)) unknown.add(token)
			}
		}
		expect([...unknown]).toEqual([])
	})

	it('holds for every button variant too', () => {
		const unknown = new Set<string>()
		for (const variant of [
			'primary',
			'outline',
			'destructive',
			'ghost',
			'link',
		] as const) {
			for (const token of colorTokens(buttonVariants({ variant }))) {
				if (!TOKENS.includes(token)) unknown.add(token)
			}
		}
		expect([...unknown]).toEqual([])
	})
})

describe('caller override', () => {
	it('lets a caller className beat the built-in', () => {
		render(
			<Alert variant="destructive" className="bg-muted" data-testid="a">
				x
			</Alert>,
		)
		const classes = classesOf(screen.getByTestId('a'))
		expect(classes).toContain('bg-muted')
		expect(classes).not.toContain('bg-destructive/10')
	})

	it('applies to the button helper as well', () => {
		expect(
			buttonVariants({ variant: 'primary', className: 'bg-muted' }),
		).toContain('bg-muted')
		expect(
			buttonVariants({ variant: 'primary', className: 'bg-muted' }),
		).not.toContain('bg-primary ')
	})
})

describe('Button', () => {
	it('defaults to type=button so it cannot submit a form by accident', () => {
		render(<Button>Go</Button>)
		expect(screen.getByRole('button', { name: 'Go' })).toHaveAttribute(
			'type',
			'button',
		)
	})

	it('still accepts an explicit submit', () => {
		render(<Button type="submit">Save</Button>)
		expect(screen.getByRole('button', { name: 'Save' })).toHaveAttribute(
			'type',
			'submit',
		)
	})

	it('drops the control box for the link variant', () => {
		// A link-styled button sitting in a sentence must not be 36px tall.
		expect(buttonVariants({ variant: 'link' })).toContain('h-auto')
		expect(buttonVariants({ variant: 'link' })).not.toContain('h-9')
	})
})

describe('Table', () => {
	it('scrolls inside its own container rather than widening the page', () => {
		const { container } = render(
			<Table>
				<TableHeader>
					<TableRow>
						<TableHead>H</TableHead>
					</TableRow>
				</TableHeader>
				<TableBody>
					<TableRow>
						<TableCell>C</TableCell>
					</TableRow>
				</TableBody>
			</Table>,
		)
		const wrapper = container.firstElementChild
		expect(classesOf(wrapper)).toContain('overflow-x-auto')
		expect(wrapper?.querySelector('table')).not.toBeNull()
		// The semantic elements survive the wrapper — a table that is not a table
		// to a screen reader would be a regression, not a style change.
		expect(screen.getByRole('columnheader')).toHaveTextContent('H')
		expect(screen.getByRole('cell')).toHaveTextContent('C')
	})
})

describe('Separator', () => {
	it('is hidden from the accessibility tree unless it means something', () => {
		const { container, rerender } = render(<Separator />)
		// An <hr>, so the separator semantics are the element's own — role="none"
		// is what *removes* them for the decorative default.
		expect(container.querySelector('hr[role="none"]')).not.toBeNull()
		expect(screen.queryByRole('separator')).toBeNull()

		rerender(<Separator decorative={false} orientation="vertical" />)
		const real = screen.getByRole('separator')
		expect(real.tagName).toBe('HR')
		expect(real).toHaveAttribute('aria-orientation', 'vertical')
		// Never the focusable-splitter shape: this is a rule, not a drag handle.
		expect(real).not.toHaveAttribute('tabindex')
	})
})
