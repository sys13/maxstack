/**
 * Org context + switcher (task 51): provider exposes the active org, the
 * switcher lists orgs and reports switches, and single-org workspaces render
 * no switcher chrome at all.
 */

import { fireEvent, render, screen } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import { OrgProvider, OrgSwitcher, useOrg } from './org-context.tsx'

const orgs = [
	{ id: 'org-acme', name: 'Acme' },
	{ id: 'org-globex', name: 'Globex' },
]

function CurrentOrgName() {
	const { currentOrg } = useOrg()
	return <span>{currentOrg?.name ?? 'none'}</span>
}

describe('OrgProvider / useOrg (task 51)', () => {
	it('resolves the current org from the id', () => {
		render(
			<OrgProvider orgs={orgs} currentOrgId="org-globex">
				<CurrentOrgName />
			</OrgProvider>,
		)
		expect(screen.getByText('Globex')).toBeInTheDocument()
	})

	it('throws outside a provider', () => {
		expect(() => render(<CurrentOrgName />)).toThrow(
			'useOrg must be used within an OrgProvider',
		)
	})
})

describe('OrgSwitcher (task 51)', () => {
	it('lists orgs and reports a switch', () => {
		const onSwitch = vi.fn()
		render(
			<OrgProvider orgs={orgs} currentOrgId="org-acme" onSwitch={onSwitch}>
				<OrgSwitcher />
			</OrgProvider>,
		)
		const select = screen.getByLabelText('Organization')
		expect(select).toHaveValue('org-acme')
		fireEvent.change(select, { target: { value: 'org-globex' } })
		expect(onSwitch).toHaveBeenCalledWith('org-globex')
	})

	it('offers a placeholder when no org is active yet', () => {
		const onSwitch = vi.fn()
		render(
			<OrgProvider orgs={orgs} onSwitch={onSwitch}>
				<OrgSwitcher />
			</OrgProvider>,
		)
		expect(screen.getByLabelText('Organization')).toHaveValue('')
		expect(screen.getByText('Select organization…')).toBeInTheDocument()
	})

	it('renders nothing for a single-org workspace', () => {
		render(
			<OrgProvider orgs={[orgs[0] as { id: string; name: string }]}>
				<OrgSwitcher />
			</OrgProvider>,
		)
		expect(screen.queryByLabelText('Organization')).not.toBeInTheDocument()
	})
})
