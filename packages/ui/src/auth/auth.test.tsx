import {
	act,
	fireEvent,
	render,
	renderHook,
	screen,
	waitFor,
} from '@testing-library/react'
import type { ReactNode } from 'react'
import { describe, expect, it, vi } from 'vitest'
import type { ResourceCapabilities } from '../resource/resource-types.ts'
import {
	type AuthProvider,
	AuthProviderContext,
	useAuth,
} from './auth-provider.tsx'
import { RequireAuth, RequireCapability } from './guards.tsx'
import { ForgotPasswordForm, LoginForm, LogoutButton } from './LoginForm.tsx'

function mockAuth(overrides: Partial<AuthProvider> = {}): AuthProvider {
	let signedIn = false
	return {
		login: vi.fn(async (c) => {
			if (c.password === 'wrong') throw new Error('Bad credentials')
			signedIn = true
		}),
		logout: vi.fn(async () => {
			signedIn = false
		}),
		checkAuth: vi.fn(async () => {
			if (!signedIn) throw new Error('anon')
		}),
		getIdentity: vi.fn(async () =>
			signedIn ? { id: 'u1', fullName: 'Ada' } : null,
		),
		getPermissions: vi.fn(async () =>
			signedIn
				? ({
						post: { read: true, create: true, update: false, delete: false },
					} as Record<string, ResourceCapabilities>)
				: {},
		),
		...overrides,
	}
}

function wrap(provider: AuthProvider) {
	return ({ children }: { children: ReactNode }) => (
		<AuthProviderContext provider={provider}>{children}</AuthProviderContext>
	)
}

describe('AuthProviderContext + useAuth', () => {
	it('starts anonymous after the initial check fails', async () => {
		const { result } = renderHook(() => useAuth(), {
			wrapper: wrap(mockAuth()),
		})
		await waitFor(() => expect(result.current.status).toBe('anonymous'))
		expect(result.current.isAuthenticated).toBe(false)
	})

	it('logs in, exposes identity + permissions, and can()', async () => {
		const { result } = renderHook(() => useAuth(), {
			wrapper: wrap(mockAuth()),
		})
		await waitFor(() => expect(result.current.status).toBe('anonymous'))
		await act(async () => {
			await result.current.login({ email: 'a@b.c', password: 'ok' })
		})
		expect(result.current.isAuthenticated).toBe(true)
		expect(result.current.identity?.fullName).toBe('Ada')
		expect(result.current.can('post', 'read')).toBe(true)
		expect(result.current.can('post', 'delete')).toBe(false)
		// Unknown resource → allowed (unrestricted default).
		expect(result.current.can('other', 'read')).toBe(true)
	})

	it('logs out back to anonymous', async () => {
		const { result } = renderHook(() => useAuth(), {
			wrapper: wrap(mockAuth()),
		})
		await waitFor(() => expect(result.current.status).toBe('anonymous'))
		await act(async () => {
			await result.current.login({ email: 'a', password: 'ok' })
		})
		await act(async () => {
			await result.current.logout()
		})
		expect(result.current.isAuthenticated).toBe(false)
	})
})

describe('LoginForm', () => {
	it('signs in and calls onSuccess', async () => {
		const provider = mockAuth()
		const onSuccess = vi.fn()
		render(
			<AuthProviderContext provider={provider}>
				<LoginForm onSuccess={onSuccess} />
			</AuthProviderContext>,
		)
		const form = screen.getByRole('form', { name: 'Sign in' })
		fireInput('Email', 'a@b.c')
		fireInput('Password', 'ok')
		await act(async () => {
			form.dispatchEvent(
				new Event('submit', { bubbles: true, cancelable: true }),
			)
		})
		await waitFor(() => expect(onSuccess).toHaveBeenCalled())
	})

	it('surfaces a login error', async () => {
		render(
			<AuthProviderContext provider={mockAuth()}>
				<LoginForm />
			</AuthProviderContext>,
		)
		const form = screen.getByRole('form', { name: 'Sign in' })
		fireInput('Email', 'a@b.c')
		fireInput('Password', 'wrong')
		await act(async () => {
			form.dispatchEvent(
				new Event('submit', { bubbles: true, cancelable: true }),
			)
		})
		await waitFor(() =>
			expect(screen.getByRole('alert')).toHaveTextContent('Bad credentials'),
		)
	})
})

describe('ForgotPasswordForm', () => {
	it('calls the provider and confirms', async () => {
		const forgotPassword = vi.fn(async () => {})
		render(
			<AuthProviderContext provider={mockAuth({ forgotPassword })}>
				<ForgotPasswordForm />
			</AuthProviderContext>,
		)
		fireInput('Email', 'a@b.c')
		const form = screen.getByRole('form', { name: 'Reset password' })
		await act(async () => {
			form.dispatchEvent(
				new Event('submit', { bubbles: true, cancelable: true }),
			)
		})
		await waitFor(() => expect(forgotPassword).toHaveBeenCalledWith('a@b.c'))
		expect(screen.getByRole('status')).toBeInTheDocument()
	})
})

describe('guards', () => {
	it('RequireAuth redirects an anonymous visitor and hides children', async () => {
		const redirect = vi.fn()
		render(
			<AuthProviderContext provider={mockAuth()}>
				<RequireAuth redirect={redirect} fallback={<span>checking</span>}>
					<span>secret</span>
				</RequireAuth>
			</AuthProviderContext>,
		)
		await waitFor(() => expect(redirect).toHaveBeenCalledWith('/login'))
		expect(screen.queryByText('secret')).not.toBeInTheDocument()
	})

	it('RequireCapability renders Forbidden when the action is denied', async () => {
		function Tree() {
			const { login } = useAuth()
			return (
				<>
					<button type="button" onClick={() => login({ password: 'ok' })}>
						login
					</button>
					<RequireCapability resource="post" action="delete">
						<span>danger zone</span>
					</RequireCapability>
				</>
			)
		}
		render(
			<AuthProviderContext provider={mockAuth()}>
				<Tree />
			</AuthProviderContext>,
		)
		await act(async () => {
			screen.getByText('login').click()
		})
		await waitFor(() => expect(screen.getByText('403')).toBeInTheDocument())
		expect(screen.queryByText('danger zone')).not.toBeInTheDocument()
	})

	it('LogoutButton signs out', async () => {
		const provider = mockAuth()
		function Tree() {
			const { login, isAuthenticated } = useAuth()
			return (
				<>
					<button type="button" onClick={() => login({ password: 'ok' })}>
						login
					</button>
					<span>auth:{String(isAuthenticated)}</span>
					<LogoutButton />
				</>
			)
		}
		render(
			<AuthProviderContext provider={provider}>
				<Tree />
			</AuthProviderContext>,
		)
		await act(async () => {
			screen.getByText('login').click()
		})
		await waitFor(() =>
			expect(screen.getByText('auth:true')).toBeInTheDocument(),
		)
		await act(async () => {
			screen.getByRole('button', { name: 'Sign out' }).click()
		})
		await waitFor(() =>
			expect(screen.getByText('auth:false')).toBeInTheDocument(),
		)
	})
})

// --- helpers ---------------------------------------------------------------
function fireInput(label: string, value: string) {
	fireEvent.change(screen.getByLabelText(label), { target: { value } })
}
