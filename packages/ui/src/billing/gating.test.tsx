import { render, renderHook, screen } from '@testing-library/react'
import type { ReactNode } from 'react'
import { describe, expect, it } from 'vitest'
import {
	EntitlementProvider,
	IfEntitled,
	IfFlag,
	useEntitlement,
	useFlag,
} from './gating.tsx'

function wrapper(entitlements: string[], flags: Record<string, boolean> = {}) {
	return function Wrapper({ children }: { children: ReactNode }) {
		return (
			<EntitlementProvider entitlements={entitlements} flags={flags}>
				{children}
			</EntitlementProvider>
		)
	}
}

describe('useEntitlement / useFlag', () => {
	it('reports granted vs ungranted entitlements', () => {
		const { result } = renderHook(
			() => ({
				analytics: useEntitlement('analytics'),
				sso: useEntitlement('sso'),
			}),
			{ wrapper: wrapper(['analytics', 'priority-support']) },
		)
		expect(result.current.analytics).toBe(true)
		expect(result.current.sso).toBe(false)
	})

	it('reports flag values, defaulting absent flags to off', () => {
		const { result } = renderHook(
			() => ({
				on: useFlag('beta'),
				absent: useFlag('unknown'),
			}),
			{ wrapper: wrapper([], { beta: true }) },
		)
		expect(result.current.on).toBe(true)
		expect(result.current.absent).toBe(false)
	})

	it('throws outside a provider', () => {
		expect(() => renderHook(() => useEntitlement('x'))).toThrow(
			'useEntitlement/useFlag must be used within an <EntitlementProvider>',
		)
	})
})

describe('<IfEntitled>', () => {
	it('renders children when the plan grants the feature', () => {
		render(
			<EntitlementProvider entitlements={['analytics']}>
				<IfEntitled feature="analytics">
					<span>Export CSV</span>
				</IfEntitled>
			</EntitlementProvider>,
		)
		expect(screen.getByText('Export CSV')).toBeInTheDocument()
	})

	it('renders the fallback (default nothing) when the plan lacks the feature', () => {
		render(
			<EntitlementProvider entitlements={[]}>
				<IfEntitled feature="analytics" fallback={<span>Upgrade</span>}>
					<span>Export CSV</span>
				</IfEntitled>
			</EntitlementProvider>,
		)
		expect(screen.queryByText('Export CSV')).not.toBeInTheDocument()
		expect(screen.getByText('Upgrade')).toBeInTheDocument()
	})
})

describe('<IfFlag>', () => {
	it('renders children only when the flag is on', () => {
		render(
			<EntitlementProvider entitlements={[]} flags={{ 'export-csv': true }}>
				<IfFlag flag="export-csv">
					<span>Beta feature</span>
				</IfFlag>
			</EntitlementProvider>,
		)
		expect(screen.getByText('Beta feature')).toBeInTheDocument()
	})

	it('hides children when the flag is off (including when unresolved)', () => {
		render(
			<EntitlementProvider entitlements={[]} flags={{ 'export-csv': false }}>
				<IfFlag flag="export-csv">
					<span>Beta feature</span>
				</IfFlag>
			</EntitlementProvider>,
		)
		expect(screen.queryByText('Beta feature')).not.toBeInTheDocument()
	})

	it('composes with <IfEntitled> to require both a plan feature and an enabled flag', () => {
		const Demo = ({
			entitlements,
			flags,
		}: {
			entitlements: string[]
			flags: Record<string, boolean>
		}) => (
			<EntitlementProvider entitlements={entitlements} flags={flags}>
				<IfEntitled feature="analytics">
					<IfFlag flag="export-csv">
						<button type="button">Export usage CSV</button>
					</IfFlag>
				</IfEntitled>
			</EntitlementProvider>
		)

		const { rerender } = render(
			<Demo entitlements={[]} flags={{ 'export-csv': true }} />,
		)
		expect(screen.queryByText('Export usage CSV')).not.toBeInTheDocument()

		rerender(
			<Demo entitlements={['analytics']} flags={{ 'export-csv': false }} />,
		)
		expect(screen.queryByText('Export usage CSV')).not.toBeInTheDocument()

		rerender(
			<Demo entitlements={['analytics']} flags={{ 'export-csv': true }} />,
		)
		expect(screen.getByText('Export usage CSV')).toBeInTheDocument()
	})
})
