/**
 * Entitlement + flag gating (task 54) — the client convenience over
 * `@maxstack/features/billing`'s `hasEntitlement` and `@maxstack/features/flags`'
 * `isFlagEnabled`. This is the entitlement dual of task-35's permission gating
 * (`<RequireCapability>`/`useAuth().can`), but hide-only: a plan or flag that
 * doesn't grant a feature hides the UI for it, it doesn't deny a route.
 *
 * Unlike `AuthProviderContext`, this is a plain-data provider, not an async
 * fetch contract — a route's loader already resolves the subject's entitlements
 * and flags server-side (see `resolveBilling`/`resolveFlags`), so the client
 * just needs that data in context, the same shape `OrgProvider` uses.
 */

import { createContext, type ReactNode, useContext, useMemo } from 'react'

export interface EntitlementProviderProps {
	children: ReactNode
	/** The current subject's granted entitlement keys (e.g. from `PlanCard.entitlements`). */
	entitlements: string[]
	/** Resolved flag values for the current subject (e.g. from `resolveFlags`). */
	flags?: Record<string, boolean>
}

interface GatingContextValue {
	entitlements: Set<string>
	flags: Record<string, boolean>
}

const GatingContext = createContext<GatingContextValue | null>(null)

export function EntitlementProvider({
	children,
	entitlements,
	flags = {},
}: EntitlementProviderProps) {
	const value = useMemo<GatingContextValue>(
		() => ({ entitlements: new Set(entitlements), flags }),
		[entitlements, flags],
	)
	return (
		<GatingContext.Provider value={value}>{children}</GatingContext.Provider>
	)
}

function useGatingContext(): GatingContextValue {
	const ctx = useContext(GatingContext)
	if (!ctx) {
		throw new Error(
			'useEntitlement/useFlag must be used within an <EntitlementProvider>',
		)
	}
	return ctx
}

/** Does the current subject's plan grant `feature`? */
export function useEntitlement(feature: string): boolean {
	return useGatingContext().entitlements.has(feature)
}

/** Is `flag` on for the current subject? Absent flags default to off. */
export function useFlag(flag: string): boolean {
	return useGatingContext().flags[flag] ?? false
}

export interface IfEntitledProps {
	children: ReactNode
	feature: string
	/** Rendered instead when the plan doesn't grant `feature` (default: nothing). */
	fallback?: ReactNode
}

/** Renders `children` only when the current plan grants `feature`. */
export function IfEntitled({
	children,
	feature,
	fallback = null,
}: IfEntitledProps) {
	return <>{useEntitlement(feature) ? children : fallback}</>
}

export interface IfFlagProps {
	children: ReactNode
	flag: string
	/** Rendered instead when the flag is off (default: nothing). */
	fallback?: ReactNode
}

/** Renders `children` only when `flag` is on for the current subject. */
export function IfFlag({ children, flag, fallback = null }: IfFlagProps) {
	return <>{useFlag(flag) ? children : fallback}</>
}
