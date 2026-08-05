import { render, screen } from '@testing-library/react'
import { describe, expect, it } from 'vitest'
import { isRollupSeries, RollupSeries } from './RollupSeries.tsx'

const shopping = [
	{ key: 'onion', value: 5 },
	{ key: 'salt', value: 1 },
]

describe('RollupSeries', () => {
	it('renders each bucket as a labelled key/value row', () => {
		render(<RollupSeries series={shopping} label="Shopping list" />)
		expect(screen.getByText('Shopping list')).toBeInTheDocument()
		expect(screen.getByText('onion')).toBeInTheDocument()
		expect(screen.getByText('5')).toBeInTheDocument()
		expect(screen.getByText('salt')).toBeInTheDocument()
	})

	// A series is tabular data, so the DOM says so — a screen reader reads
	// key/value pairs rather than trying to interpret bar widths.
	it('is a table with row headers and a caption, not a pile of divs', () => {
		render(<RollupSeries series={shopping} label="Shopping list" />)
		const table = screen.getByRole('table')
		expect(table).toBeInTheDocument()
		expect(screen.getByRole('rowheader', { name: 'onion' })).toBeInTheDocument()
		expect(table).toHaveAccessibleName(/Shopping list — 2 groups/)
	})

	it('singularizes the caption for one group', () => {
		render(<RollupSeries series={[{ key: 'onion', value: 5 }]} label="X" />)
		expect(screen.getByRole('table')).toHaveAccessibleName(/1 group$/)
	})

	// #170's honest-failure rule at the presentation layer: a legitimate empty must
	// not render as a blank card that reads like a bug.
	it('says so in words when the series is empty', () => {
		render(<RollupSeries series={[]} label="Shopping list" />)
		expect(screen.getByText('No data yet')).toBeInTheDocument()
		expect(screen.queryByRole('table')).not.toBeInTheDocument()
	})

	it('takes a custom empty label', () => {
		render(<RollupSeries series={[]} emptyLabel="Nothing planned" />)
		expect(screen.getByText('Nothing planned')).toBeInTheDocument()
	})

	it('scales bars against the series max, not an arbitrary floor', () => {
		const { container } = render(<RollupSeries series={shopping} />)
		const bars = [...container.querySelectorAll('[style*="width"]')]
		expect((bars[0] as HTMLElement).style.width).toBe('100%')
		expect((bars[1] as HTMLElement).style.width).toBe('20%')
	})

	// A null aggregate means "no value", which is not the same as zero — so it gets
	// no bar at all rather than a zero-length one that reads as a measured zero.
	it('renders a null value as an em dash with no bar', () => {
		const { container } = render(
			<RollupSeries series={[{ key: 'a', value: null }]} />,
		)
		expect(screen.getByText('—')).toBeInTheDocument()
		const bar = container.querySelector('[style*="width"]') as HTMLElement
		expect(bar.style.width).toBe('0%')
	})

	it('renders a null key as an em dash', () => {
		render(<RollupSeries series={[{ key: null, value: 3 }]} />)
		expect(screen.getByRole('rowheader', { name: '—' })).toBeInTheDocument()
	})

	it('applies custom key and value formatters', () => {
		render(
			<RollupSeries
				series={[{ key: '2026-07-01T00:00:00.000Z', value: 1234 }]}
				formatKey={(k) => (k ?? '').slice(0, 7)}
				formatValue={(v) => `$${v}`}
			/>,
		)
		expect(screen.getByText('2026-07')).toBeInTheDocument()
		expect(screen.getByText('$1234')).toBeInTheDocument()
	})

	// A rollup over a signed column can go negative; the bar should stay
	// proportionate rather than collapsing or overflowing.
	it('scales negative values off the same magnitude max', () => {
		const { container } = render(
			<RollupSeries
				series={[
					{ key: 'a', value: -10 },
					{ key: 'b', value: 5 },
				]}
			/>,
		)
		const bars = [...container.querySelectorAll('[style*="width"]')]
		expect((bars[0] as HTMLElement).style.width).toBe('100%')
		expect((bars[1] as HTMLElement).style.width).toBe('50%')
	})

	it('survives an all-zero series without dividing by zero', () => {
		const { container } = render(
			<RollupSeries series={[{ key: 'a', value: 0 }]} />,
		)
		const bar = container.querySelector('[style*="width"]') as HTMLElement
		expect(bar.style.width).toBe('0%')
	})
})

describe('isRollupSeries', () => {
	it('recognizes a series so the generic renderer can branch on it', () => {
		expect(isRollupSeries(shopping)).toBe(true)
		expect(isRollupSeries([{ key: null, value: null }])).toBe(true)
		expect(isRollupSeries([])).toBe(true)
	})

	it('rejects a scalar, a plain array, and a non-array', () => {
		expect(isRollupSeries(5)).toBe(false)
		expect(isRollupSeries(null)).toBe(false)
		expect(isRollupSeries(['onion'])).toBe(false)
		expect(isRollupSeries([{ key: 'a' }])).toBe(false)
		expect(isRollupSeries([{ key: 'a', value: 'five' }])).toBe(false)
	})
})
