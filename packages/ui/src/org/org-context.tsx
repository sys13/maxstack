/**
 * Organization context + switcher (Plan v5 task 51). The client half of
 * d-tenancy-model: the server scopes tenant resources by the active-org cookie;
 * this provides the shell affordance that sets it. `OrgProvider` holds the org
 * list + active org, `useOrg` exposes them, and `<OrgSwitcher>` renders the
 * dropdown an app drops above its `<Menu>`. Switching calls `onSwitch(orgId)` —
 * the app persists the choice (cookie + reload, typically), keeping this
 * component router- and transport-agnostic like the rest of the shell.
 */

import {
	createContext,
	type ReactNode,
	useCallback,
	useContext,
	useMemo,
} from 'react'
import { cn } from '../lib/cn.ts'

/** One organization the current user belongs to. */
export interface OrgSummary {
	id: string
	name: string
}

export interface OrgContextValue {
	orgs: OrgSummary[]
	currentOrgId: string | null
	/** The active org's summary, or null when none is selected. */
	currentOrg: OrgSummary | null
	switchOrg: (orgId: string) => void
}

const OrgContext = createContext<OrgContextValue | null>(null)

export interface OrgProviderProps {
	orgs: OrgSummary[]
	currentOrgId?: string | null
	/** Persist the switch (set the org cookie, refetch/reload). */
	onSwitch?: (orgId: string) => void
	children: ReactNode
}

export function OrgProvider({
	orgs,
	currentOrgId = null,
	onSwitch,
	children,
}: OrgProviderProps) {
	const switchOrg = useCallback(
		(orgId: string) => onSwitch?.(orgId),
		[onSwitch],
	)
	const value = useMemo<OrgContextValue>(
		() => ({
			orgs,
			currentOrgId,
			currentOrg: orgs.find((o) => o.id === currentOrgId) ?? null,
			switchOrg,
		}),
		[orgs, currentOrgId, switchOrg],
	)
	return <OrgContext.Provider value={value}>{children}</OrgContext.Provider>
}

/** The active org + switcher. Throws outside an `OrgProvider`. */
export function useOrg(): OrgContextValue {
	const ctx = useContext(OrgContext)
	if (!ctx) throw new Error('useOrg must be used within an OrgProvider')
	return ctx
}

export interface OrgSwitcherProps {
	className?: string
	/** Accessible label for the select. */
	label?: string
}

/**
 * A select over the user's orgs. Renders nothing when the user belongs to at
 * most one org — a single-org workspace shouldn't grow chrome for a switch
 * that can't happen.
 */
export function OrgSwitcher({
	className,
	label = 'Organization',
}: OrgSwitcherProps) {
	const { orgs, currentOrgId, switchOrg } = useOrg()
	if (orgs.length <= 1) return null
	return (
		<select
			aria-label={label}
			value={currentOrgId ?? ''}
			onChange={(e) => {
				if (e.target.value) switchOrg(e.target.value)
			}}
			className={cn(
				'w-full rounded-md border border-input bg-transparent px-3 py-2 text-sm',
				className,
			)}
		>
			{currentOrgId ? null : <option value="">Select organization…</option>}
			{orgs.map((org) => (
				<option key={org.id} value={org.id}>
					{org.name}
				</option>
			))}
		</select>
	)
}
