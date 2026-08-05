import { render, screen, waitFor } from '@testing-library/react'
import type { ReactNode } from 'react'
import { describe, expect, it } from 'vitest'
import { DataProvider } from '../data/data-context.tsx'
import { createMemoryDataProvider } from '../data/memory-provider.ts'
import { QueryClient } from '../data/query-client.ts'
import {
	AggregateWidget,
	CountWidget,
	RecentActivity,
	StatCard,
} from './widgets.tsx'

function wrap(dp = seededProvider()) {
	return ({ children }: { children: ReactNode }) => (
		<DataProvider dataProvider={dp} queryClient={new QueryClient()}>
			{children}
		</DataProvider>
	)
}

function seededProvider() {
	return createMemoryDataProvider({
		data: {
			post: [
				{ id: '1', title: 'Alpha', points: 10, createdAt: '2026-01-01' },
				{ id: '2', title: 'Beta', points: 30, createdAt: '2026-03-01' },
				{ id: '3', title: 'Gamma', points: 20, createdAt: '2026-02-01' },
			],
		},
	})
}

describe('StatCard', () => {
	it('renders a label and value, or a skeleton while loading', () => {
		const { rerender } = render(<StatCard label="Total" value="42" />)
		expect(screen.getByText('Total')).toBeInTheDocument()
		expect(screen.getByText('42')).toBeInTheDocument()
		rerender(<StatCard label="Total" value="42" loading />)
		expect(screen.getByTestId('stat-skeleton')).toBeInTheDocument()
	})
})

describe('CountWidget', () => {
	it('shows the resource count', async () => {
		render(<CountWidget resource="post" label="Posts" />, { wrapper: wrap() })
		await waitFor(() => expect(screen.getByText('3')).toBeInTheDocument())
	})

	it('shows unavailable when the provider has no aggregate support', async () => {
		const restLike = {
			getList: async () => ({ data: [], total: 0 }),
			getOne: async () => ({}),
			getMany: async () => [],
			create: async (_r: string, d: Record<string, unknown>) => d,
			update: async (_r: string, _i: string, d: Record<string, unknown>) => d,
			delete: async (_r: string, id: string) => ({ id }),
		}
		render(<CountWidget resource="post" />, {
			wrapper: wrap(restLike as never),
		})
		await waitFor(() =>
			expect(screen.getByText('unavailable')).toBeInTheDocument(),
		)
	})
})

describe('AggregateWidget', () => {
	it('shows a sum with an optional formatter', async () => {
		render(
			<AggregateWidget
				resource="post"
				op="sum"
				field="points"
				format={(n) => `$${n}`}
			/>,
			{ wrapper: wrap() },
		)
		await waitFor(() => expect(screen.getByText('$60')).toBeInTheDocument())
	})
})

describe('RecentActivity', () => {
	it('lists the newest records first', async () => {
		render(
			<RecentActivity
				resource="post"
				limit={2}
				renderItem={(row) => <span>{String(row.title)}</span>}
			/>,
			{ wrapper: wrap() },
		)
		await waitFor(() => expect(screen.getByText('Beta')).toBeInTheDocument())
		expect(screen.getByText('Gamma')).toBeInTheDocument()
		expect(screen.queryByText('Alpha')).not.toBeInTheDocument()
	})
})
