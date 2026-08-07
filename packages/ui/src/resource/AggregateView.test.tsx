import { render, screen } from '@testing-library/react'
import { describe, expect, it } from 'vitest'
import {
	AggregateView,
	aggregateKeyLabel,
	aggregateLabel,
} from './AggregateView.tsx'

const byStatus = [
	{ key: 'open', value: 7, count: 7 },
	{ key: 'closed', value: 2, count: 2 },
	{ key: null, value: 1, count: 1 },
]

describe('AggregateView', () => {
	it('draws each bucket with a caption saying what the number is', () => {
		render(<AggregateView buckets={byStatus} groupField="status" fn="count" />)
		expect(screen.getByText('Records by status')).toBeInTheDocument()
		expect(screen.getByRole('rowheader', { name: 'open' })).toBeInTheDocument()
		expect(screen.getByText('7')).toBeInTheDocument()
	})

	// A bucket for the rows with no value is a real answer, not a rendering
	// failure — an unlabelled bar is indistinguishable from a bug.
	it('labels the null bucket rather than rendering it blank', () => {
		render(<AggregateView buckets={byStatus} groupField="status" fn="count" />)
		expect(
			screen.getByRole('rowheader', { name: 'Not set' }),
		).toBeInTheDocument()
	})

	it('uses a declared option label in place of the stored value', () => {
		render(
			<AggregateView
				buckets={[{ key: 'open', value: 7, count: 7 }]}
				groupField="status"
				fn="count"
				options={[{ value: 'open', label: 'Still open' }]}
			/>,
		)
		expect(
			screen.getByRole('rowheader', { name: 'Still open' }),
		).toBeInTheDocument()
	})

	it('reads a boolean dimension as Yes/No, not as the strings the driver sent', () => {
		render(
			<AggregateView
				buckets={[
					{ key: 'true', value: 3, count: 3 },
					{ key: 'false', value: 1, count: 1 },
				]}
				groupField="urgent"
				fn="count"
			/>,
		)
		expect(screen.getByRole('rowheader', { name: 'Yes' })).toBeInTheDocument()
		expect(screen.getByRole('rowheader', { name: 'No' })).toBeInTheDocument()
	})

	// The table display exists for exactly this: an average of 9.8 over two rows
	// and over two thousand are different claims, and a bar cannot tell them
	// apart.
	it('shows the bucket size beside an average in the table display', () => {
		render(
			<AggregateView
				buckets={[{ key: 'enterprise', value: 9.75, count: 2000 }]}
				groupField="segment"
				fn="avg"
				measureField="score"
				display="table"
			/>,
		)
		expect(screen.getByText('Average score by segment')).toBeInTheDocument()
		expect(screen.getByText('9.8')).toBeInTheDocument()
		expect(screen.getByText('2,000')).toBeInTheDocument()
	})

	it('says an empty result is empty, rather than drawing a blank card', () => {
		render(<AggregateView buckets={[]} groupField="status" fn="count" />)
		expect(screen.getByText(/No records to summarise yet/)).toBeInTheDocument()
	})
})

describe('aggregateLabel', () => {
	it('names the number in words for every function', () => {
		expect(aggregateLabel('count', undefined)).toBe('Records')
		expect(aggregateLabel('sum', 'amountDue')).toBe('Total amount due')
		expect(aggregateLabel('avg', 'score')).toBe('Average score')
		expect(aggregateLabel('min', 'score')).toBe('Lowest score')
		expect(aggregateLabel('max', 'score')).toBe('Highest score')
		expect(aggregateLabel('countDistinct', 'owner')).toBe('Distinct owner')
	})
})

describe('aggregateKeyLabel', () => {
	// The key is a `date_trunc` boundary. Rendering it in the viewer's zone puts
	// a month bucket in the previous month for everybody west of UTC, which
	// relabels every bar in the chart.
	it('renders a date bucket in UTC, at the period’s own resolution', () => {
		expect(
			aggregateKeyLabel('2026-03-01T00:00:00.000Z', 'month', null),
		).toMatch(/Mar 2026/)
		expect(aggregateKeyLabel('2026-03-01T00:00:00.000Z', 'year', null)).toBe(
			'2026',
		)
	})

	it('falls back to the raw key when it is not a date after all', () => {
		expect(aggregateKeyLabel('not-a-date', 'month', null)).toBe('not-a-date')
	})
})
