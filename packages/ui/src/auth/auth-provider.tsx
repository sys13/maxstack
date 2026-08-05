/**
 * The auth-provider seam (Plan v5 task 48) — the client-side counterpart to the
 * server RBAC (task 22) and the capability rendering (task 35). It's the exact
 * react-admin shape: a small `AuthProvider` contract the app implements against
 * its backend (login / logout / checkAuth / getIdentity / getPermissions), put in
 * React context by `<AuthProviderContext>`, and read by `useAuth`. The guards and
 * login form (this task) sit on top; swapping the backend is one object, no
 * component change — the same decoupling the data provider gives the CRUD hooks.
 */

import {
	createContext,
	type ReactNode,
	useCallback,
	useContext,
	useEffect,
	useMemo,
	useState,
} from 'react'
import type { ResourceCapabilities } from '../resource/resource-types.ts'

/** The signed-in user, as thin as the UI needs (id + a display label + anything). */
export interface Identity {
	id: string
	fullName?: string
	avatar?: string
	[key: string]: unknown
}

/** The contract an app implements against its backend. Every method is async so a
 * real network implementation fits; a test/mock implements them synchronously. */
export interface AuthProvider {
	/** Sign in with arbitrary credentials; rejects on failure. */
	login(credentials: Record<string, unknown>): Promise<void>
	/** Sign out; clears any session. */
	logout(): Promise<void>
	/** Resolve if the current session is valid, reject/throw otherwise — the
	 * guard calls this to decide redirect-to-login. */
	checkAuth(): Promise<void>
	/** The current user, or `null` when signed out. */
	getIdentity(): Promise<Identity | null>
	/** Per-resource capabilities for the session (feeds the menu + guards). */
	getPermissions(): Promise<Record<string, ResourceCapabilities>>
	/** Optional: request a password reset for an email. */
	forgotPassword?(email: string): Promise<void>
}

type AuthStatus = 'checking' | 'authenticated' | 'anonymous'

interface AuthContextValue {
	provider: AuthProvider
	status: AuthStatus
	identity: Identity | null
	permissions: Record<string, ResourceCapabilities>
	login: (credentials: Record<string, unknown>) => Promise<void>
	logout: () => Promise<void>
	refresh: () => Promise<void>
}

const AuthContext = createContext<AuthContextValue | null>(null)

export interface AuthProviderContextProps {
	provider: AuthProvider
	children: ReactNode
	/** Skip the initial `checkAuth` (e.g. SSR handed a known session). */
	skipInitialCheck?: boolean
}

export function AuthProviderContext({
	provider,
	children,
	skipInitialCheck = false,
}: AuthProviderContextProps) {
	const [status, setStatus] = useState<AuthStatus>(
		skipInitialCheck ? 'anonymous' : 'checking',
	)
	const [identity, setIdentity] = useState<Identity | null>(null)
	const [permissions, setPermissions] = useState<
		Record<string, ResourceCapabilities>
	>({})

	const load = useCallback(async () => {
		try {
			await provider.checkAuth()
			const [id, perms] = await Promise.all([
				provider.getIdentity(),
				provider.getPermissions(),
			])
			setIdentity(id)
			setPermissions(perms)
			setStatus('authenticated')
		} catch {
			setIdentity(null)
			setPermissions({})
			setStatus('anonymous')
		}
	}, [provider])

	// biome-ignore lint/correctness/useExhaustiveDependencies: run once per provider on mount.
	useEffect(() => {
		if (!skipInitialCheck) void load()
	}, [load])

	const login = useCallback(
		async (credentials: Record<string, unknown>) => {
			await provider.login(credentials)
			await load()
		},
		[provider, load],
	)

	const logout = useCallback(async () => {
		await provider.logout()
		setIdentity(null)
		setPermissions({})
		setStatus('anonymous')
	}, [provider])

	const value = useMemo<AuthContextValue>(
		() => ({
			provider,
			status,
			identity,
			permissions,
			login,
			logout,
			refresh: load,
		}),
		[provider, status, identity, permissions, login, logout, load],
	)

	return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>
}

export interface UseAuthResult {
	status: AuthStatus
	isAuthenticated: boolean
	isChecking: boolean
	identity: Identity | null
	permissions: Record<string, ResourceCapabilities>
	login: (credentials: Record<string, unknown>) => Promise<void>
	logout: () => Promise<void>
	refresh: () => Promise<void>
	/** Convenience: can the session perform `action` on `resource`? Absent
	 * permissions → allowed (the unrestricted default, matching `<ResourceList>`). */
	can: (resource: string, action: keyof ResourceCapabilities) => boolean
}

/** The raw `AuthProvider` — for the escape hatch methods not on `useAuth`'s
 * surface (e.g. `forgotPassword`). */
export function useAuthProvider(): AuthProvider {
	const ctx = useContext(AuthContext)
	if (!ctx)
		throw new Error(
			'useAuthProvider must be used within an <AuthProviderContext>',
		)
	return ctx.provider
}

export function useAuth(): UseAuthResult {
	const ctx = useContext(AuthContext)
	if (!ctx)
		throw new Error('useAuth must be used within an <AuthProviderContext>')
	const { status, identity, permissions, login, logout, refresh } = ctx
	const can = useCallback(
		(resource: string, action: keyof ResourceCapabilities) => {
			const caps = permissions[resource]
			return caps ? caps[action] : true
		},
		[permissions],
	)
	return {
		status,
		isAuthenticated: status === 'authenticated',
		isChecking: status === 'checking',
		identity,
		permissions,
		login,
		logout,
		refresh,
		can,
	}
}
