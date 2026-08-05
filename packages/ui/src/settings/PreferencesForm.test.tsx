import { render, screen } from '@testing-library/react'
import { describe, expect, it } from 'vitest'
import { type PreferenceGroup, PreferencesForm } from './PreferencesForm.tsx'

const groups: PreferenceGroup[] = [
	{
		group: 'Notifications',
		fields: [
			{
				key: 'email-notifications',
				label: 'Email notifications',
				description: 'Send transactional email.',
				type: 'boolean',
				group: 'Notifications',
				value: true,
				source: 'organization',
				editable: true,
			},
			{
				key: 'digest-frequency',
				label: 'Digest frequency',
				type: 'enum',
				options: [
					{ label: 'Daily', value: 'daily' },
					{ label: 'Weekly', value: 'weekly' },
				],
				group: 'Notifications',
				value: 'weekly',
				source: 'user',
				editable: true,
			},
		],
	},
	{
		group: 'Security',
		fields: [
			{
				key: 'session-timeout-minutes',
				label: 'Session timeout',
				type: 'number',
				group: 'Security',
				value: 60,
				source: 'default',
				editable: false,
			},
		],
	},
]

describe('<PreferencesForm>', () => {
	it('renders one input per declaration, grouped as declared', () => {
		render(<PreferencesForm groups={groups} />)
		expect(screen.getByText('Notifications')).toBeInTheDocument()
		expect(screen.getByText('Security')).toBeInTheDocument()
		expect(screen.getByLabelText(/Email notifications/)).toHaveAttribute(
			'type',
			'checkbox',
		)
		expect(screen.getByLabelText(/Digest frequency/).tagName).toBe('SELECT')
		expect(screen.getByLabelText(/Session timeout/)).toHaveAttribute(
			'type',
			'number',
		)
	})

	it('pairs every checkbox with a hidden "off" so unchecking actually submits', () => {
		// The bug this prevents: an unchecked box submits nothing, the action sees
		// no key, and "turn it off and save" leaves the old value in place.
		const { container } = render(<PreferencesForm groups={groups} />)
		const hidden = container.querySelector(
			'input[type="hidden"][name="email-notifications"]',
		)
		expect(hidden).toHaveValue('off')
	})

	it('labels an inherited value and leaves an own choice unlabeled', () => {
		render(<PreferencesForm groups={groups} />)
		expect(screen.getAllByText('from your organization')).toHaveLength(1)
	})

	it('disables a field this scope may not edit, and everything while busy', () => {
		const { rerender } = render(<PreferencesForm groups={groups} />)
		expect(screen.getByLabelText(/Session timeout/)).toBeDisabled()
		expect(screen.getByLabelText(/Email notifications/)).not.toBeDisabled()

		rerender(<PreferencesForm groups={groups} busy />)
		expect(screen.getByLabelText(/Email notifications/)).toBeDisabled()
	})

	it('renders the empty state when nothing is declared', () => {
		render(
			<PreferencesForm groups={[]} emptyState={<p>No preferences yet.</p>} />,
		)
		expect(screen.getByText('No preferences yet.')).toBeInTheDocument()
	})
})
