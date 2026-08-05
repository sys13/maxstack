/**
 * The guard on a destructive submit. The load-bearing assertion is
 * the first one: the resting control must not be a `type="submit"`, or the
 * "confirmation" would fire the very submission it is supposed to hold back.
 */
import { fireEvent, render, screen } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import { ConfirmButton } from './ConfirmButton.tsx'

describe('ConfirmButton', () => {
	it('does not submit on the first click — it arms', () => {
		const onSubmit = vi.fn((e: React.FormEvent) => e.preventDefault())
		render(
			<form onSubmit={onSubmit}>
				<ConfirmButton label="Delete" />
			</form>,
		)
		const resting = screen.getByRole('button', { name: 'Delete' })
		expect(resting).toHaveAttribute('type', 'button')

		fireEvent.click(resting)
		expect(onSubmit).not.toHaveBeenCalled()
		expect(screen.getByText('Delete?')).toBeInTheDocument()
		expect(screen.getByRole('button', { name: 'Delete' })).toHaveAttribute(
			'type',
			'submit',
		)
	})

	it('submits on the second (confirming) click', () => {
		const onSubmit = vi.fn((e: React.FormEvent) => e.preventDefault())
		render(
			<form onSubmit={onSubmit}>
				<ConfirmButton label="Delete" />
			</form>,
		)
		fireEvent.click(screen.getByRole('button', { name: 'Delete' }))
		fireEvent.click(screen.getByRole('button', { name: 'Delete' }))
		expect(onSubmit).toHaveBeenCalledTimes(1)
	})

	it('disarms on cancel, back to the inert resting button', () => {
		render(
			<form>
				<ConfirmButton label="Delete" confirmLabel="Really?" />
			</form>,
		)
		fireEvent.click(screen.getByRole('button', { name: 'Delete' }))
		expect(screen.getByText('Really?')).toBeInTheDocument()
		fireEvent.click(screen.getByRole('button', { name: 'Cancel' }))
		expect(screen.queryByText('Really?')).not.toBeInTheDocument()
		expect(screen.getByRole('button', { name: 'Delete' })).toHaveAttribute(
			'type',
			'button',
		)
	})

	it('shows a disabled pending state while the submission is in flight', () => {
		render(<ConfirmButton label="Delete" pending pendingLabel="Deleting…" />)
		expect(screen.getByRole('button', { name: 'Deleting…' })).toBeDisabled()
	})
})
