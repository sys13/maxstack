/**
 * Route guards (Plan v5 task 48) over the auth-provider seam. `<RequireAuth>`
 * gates a subtree on an authenticated session, redirecting anonymous visitors to
 * login (via an injected `redirect` so it fits any router); `<RequireCapability>`
 * gates on a task-35 capability, rendering the access-denied page instead of a
 * crash. Both show a fallback while the initial `checkAuth` is in flight so
 * protected content never flashes before the check resolves.
 */

import { type ReactNode, useEffect } from 'react'
import { Forbidden } from '../registry/shell.tsx'
import type { ResourceCapabilities } from '../resource/resource-types.ts'
import { useAuth } from './auth-provider.tsx'

export interface RequireAuthProps {
	children: ReactNode
	/** Called to send an anonymous visitor to login (router's navigate/redirect).
	 * Given the login path so the caller can append a `?next=` return URL. */
	redirect?: (loginPath: string) => void
	/** Login route to redirect to (default `/login`). */
	loginPath?: string
	/** Shown while the session check is in flight (default: nothing). */
	fallback?: ReactNode
	/** Rendered for an anonymous visitor when no `redirect` is given (an inline
	 * sign-in prompt instead of a navigation). */
	anonymous?: ReactNode
}

export function RequireAuth({
	children,
	redirect,
	loginPath = '/login',
	fallback = null,
	anonymous = null,
}: RequireAuthProps) {
	const { isAuthenticated, isChecking } = useAuth()

	useEffect(() => {
		if (!isChecking && !isAuthenticated) redirect?.(loginPath)
	}, [isChecking, isAuthenticated, redirect, loginPath])

	if (isChecking) return <>{fallback}</>
	if (!isAuthenticated) return <>{anonymous}</>
	return <>{children}</>
}

export interface RequireCapabilityProps {
	children: ReactNode
	resource: string
	action?: keyof ResourceCapabilities
	/** What to render when denied (default: the `<Forbidden>` page). */
	deniedFallback?: ReactNode
	fallback?: ReactNode
}

export function RequireCapability({
	children,
	resource,
	action = 'read',
	deniedFallback,
	fallback = null,
}: RequireCapabilityProps) {
	const { isChecking, can } = useAuth()
	if (isChecking) return <>{fallback}</>
	if (!can(resource, action)) return <>{deniedFallback ?? <Forbidden />}</>
	return <>{children}</>
}
