import { act, render, screen, waitFor } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import type { Snapshot } from './diff.ts'
import { RevisionHistory } from './RevisionHistory.tsx'

const snaps: Snapshot[] = [
	{
		id: 'r1',
		createdAt: '2026-01-01T00:00:00Z',
		userId: 'u1',
		action: 'created',
		snapshot: { id: '1', title: 'A', points: 1 },
	},
	{
		id: 'r2',
		createdAt: '2026-01-02T00:00:00Z',
		userId: 'u2',
		action: 'updated',
		snapshot: { id: '1', title: 'B', points: 1 },
	},
]

describe('RevisionHistory', () => {
	it('renders a field-level diff per revision (newest first)', () => {
		// snaps is ascending; the default order='desc' input would mis-diff, so
		// declare the input order explicitly.
		render(<RevisionHistory snapshots={snaps} order="asc" />)
		const items = screen.getAllByRole('listitem')
		// The updated revision (r2) shows the title change; the first is "Initial".
		const withDiff = items.find((el) => el.textContent?.includes('title'))
		expect(withDiff).toHaveTextContent('A')
		expect(withDiff).toHaveTextContent('B')
		expect(screen.getByText('Initial version.')).toBeInTheDocument()
	})

	it('offers restore on non-initial revisions and calls onRestore', async () => {
		const onRestore = vi.fn(async () => {})
		render(
			<RevisionHistory snapshots={snaps} order="asc" onRestore={onRestore} />,
		)
		const buttons = screen.getAllByRole('button', { name: 'Restore' })
		// Only the newest (non-first) revision has a restore button.
		expect(buttons).toHaveLength(1)
		await act(async () => {
			buttons[0]?.click()
		})
		await waitFor(() =>
			expect(onRestore).toHaveBeenCalledWith(
				expect.objectContaining({ id: 'r2' }),
			),
		)
	})

	it('renders an empty state', () => {
		render(<RevisionHistory snapshots={[]} />)
		expect(screen.getByText('No revisions yet.')).toBeInTheDocument()
	})
})
