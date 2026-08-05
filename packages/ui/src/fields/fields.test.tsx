import { render, screen } from '@testing-library/react'
import { describe, expect, it } from 'vitest'
import type { IntrospectedColumn } from './field-semantics.ts'
import {
	BooleanField,
	DateField,
	EnumChip,
	Field,
	formatDuration,
	looksLikeImageSrc,
	NumberField,
	parseLatLng,
	relativeTime,
} from './fields.tsx'

const col = (over: Partial<IntrospectedColumn>): IntrospectedColumn => ({
	name: 'x',
	type: 'string',
	...over,
})

describe('relativeTime', () => {
	const now = new Date('2026-07-10T12:00:00Z')
	it('formats past and future', () => {
		expect(relativeTime(new Date('2026-07-07T12:00:00Z'), now)).toBe(
			'3 days ago',
		)
		expect(relativeTime(new Date('2026-07-10T14:00:00Z'), now)).toBe(
			'in 2 hours',
		)
		expect(relativeTime(new Date('2026-07-10T11:59:50Z'), now)).toBe('just now')
	})
})

describe('semantic fields', () => {
	it('DateField renders relative by default, absolute with format', () => {
		const { rerender } = render(<DateField value="2020-01-15T00:00:00Z" />)
		expect(screen.getByText(/ago/)).toBeInTheDocument()
		rerender(
			<DateField
				value="2020-01-15T00:00:00Z"
				column={col({ type: 'date', meta: { format: 'date' } })}
			/>,
		)
		expect(screen.getByText('2020-01-15')).toBeInTheDocument()
	})

	it('BooleanField renders check/x and empty for null', () => {
		const { rerender } = render(<BooleanField value={true} />)
		expect(screen.getByLabelText('yes')).toHaveTextContent('✓')
		rerender(<BooleanField value={false} />)
		expect(screen.getByLabelText('no')).toHaveTextContent('✗')
		rerender(<BooleanField value={null} />)
		expect(screen.getByText('—')).toBeInTheDocument()
	})

	// #283: a vintage of 2019 rendered as "2,019". Grouping is right for a price
	// and wrong for a year, a port, an id or a model number, so the default is
	// plain and grouping is asked for.
	it('NumberField renders plain by default, grouped only on request', () => {
		const { rerender } = render(<NumberField value={2019} />)
		expect(screen.getByText('2019')).toBeInTheDocument()
		rerender(
			<NumberField
				value={1234}
				column={col({ type: 'number', meta: { format: 'grouped' } })}
			/>,
		)
		expect(screen.getByText('1,234')).toBeInTheDocument()
	})

	it('NumberField honors format/prefix/suffix', () => {
		const { rerender } = render(<NumberField value={1234} />)
		expect(screen.getByText('1234')).toBeInTheDocument()
		rerender(
			<NumberField
				value={0.42}
				column={col({ type: 'number', meta: { format: 'percent' } })}
			/>,
		)
		expect(screen.getByText('42%')).toBeInTheDocument()
		rerender(
			<NumberField
				value={5}
				column={col({ type: 'number', meta: { suffix: ' pts' } })}
			/>,
		)
		expect(screen.getByText('5 pts')).toBeInTheDocument()
	})

	it('EnumChip shows the option label when metadata provides one', () => {
		render(
			<EnumChip
				value="a"
				column={col({
					type: 'enum',
					meta: { options: [{ label: 'Active', value: 'a' }] },
				})}
			/>,
		)
		expect(screen.getByText('Active')).toBeInTheDocument()
	})
})

describe('Field dispatcher', () => {
	it('renders an email as a mailto link', () => {
		render(
			<Field value="a@b.com" column={col({ name: 'email', type: 'string' })} />,
		)
		const link = screen.getByRole('link', { name: 'a@b.com' })
		expect(link).toHaveAttribute('href', 'mailto:a@b.com')
	})

	it('renders a url as an external link showing the host', () => {
		render(
			<Field
				value="https://example.com/path"
				column={col({ name: 'homepage', type: 'string' })}
			/>,
		)
		const link = screen.getByRole('link', { name: 'example.com' })
		expect(link).toHaveAttribute('href', 'https://example.com/path')
	})

	it('renders a name-inferred image column as an img only for URL-like values', () => {
		// A real image URL renders an <img> …
		const { rerender, container } = render(
			<Field
				value="https://example.com/kb.png"
				column={col({ name: 'icon', type: 'string' })}
			/>,
		)
		expect(container.querySelector('img')).toHaveAttribute(
			'src',
			'https://example.com/kb.png',
		)

		// … but plain text in an `icon` field (an emoji) must not become a
		// broken <img src="⌨️">.
		rerender(<Field value="⌨️" column={col({ name: 'icon', type: 'string' })} />)
		expect(container.querySelector('img')).toBeNull()
		expect(screen.getByText('⌨️')).toBeInTheDocument()
	})

	it('looksLikeImageSrc accepts URLs, paths, and image filenames only', () => {
		expect(looksLikeImageSrc('https://a.com/x')).toBe(true)
		expect(looksLikeImageSrc('data:image/png;base64,AAAA')).toBe(true)
		expect(looksLikeImageSrc('/uploads/avatar')).toBe(true)
		expect(looksLikeImageSrc('./pic.jpg')).toBe(true)
		expect(looksLikeImageSrc('photo.webp?v=2')).toBe(true)
		expect(looksLikeImageSrc('⌨️')).toBe(false)
		expect(looksLikeImageSrc('keyboard')).toBe(false)
	})

	it('falls back to text with no column', () => {
		render(<Field value="hello" />)
		expect(screen.getByText('hello')).toBeInTheDocument()
	})

	it('renders an empty dash for null', () => {
		render(<Field value={null} column={col({ type: 'string' })} />)
		expect(screen.getByText('—')).toBeInTheDocument()
	})
})

describe('specialty display fields (task 39)', () => {
	it('formatDuration humanizes seconds', () => {
		expect(formatDuration(0)).toBe('0s')
		expect(formatDuration(90)).toBe('1m 30s')
		expect(formatDuration(3661)).toBe('1h 1m 1s')
	})

	it('parseLatLng reads a "lat,lng" string or object', () => {
		expect(parseLatLng('40.7,-74')).toEqual({ lat: 40.7, lng: -74 })
		expect(parseLatLng({ lat: 1, lng: 2 })).toEqual({ lat: 1, lng: 2 })
		expect(parseLatLng('nonsense')).toBeNull()
	})

	it('dispatches color / rating / password / geo / json by inference', () => {
		const { rerender } = render(
			<Field value="#ff8800" column={col({ name: 'brandColor' })} />,
		)
		expect(screen.getByText('#ff8800')).toBeInTheDocument()

		rerender(
			<Field
				value={3}
				column={col({
					name: 'rating',
					type: 'number',
					meta: { format: 'rating' },
				})}
			/>,
		)
		expect(screen.getByLabelText('3 out of 5')).toBeInTheDocument()

		// A secret never renders its value.
		rerender(<Field value="hunter2" column={col({ name: 'password' })} />)
		expect(screen.queryByText('hunter2')).not.toBeInTheDocument()

		rerender(
			<Field
				value="40.7,-74"
				column={col({ name: 'geo', meta: { format: 'geo' } })}
			/>,
		)
		expect(screen.getByRole('link')).toHaveTextContent('40.70000, -74.00000')

		rerender(<Field value={{ a: 1 }} column={col({ type: 'json' })} />)
		expect(screen.getByText(/"a": 1/)).toBeInTheDocument()
	})
})
