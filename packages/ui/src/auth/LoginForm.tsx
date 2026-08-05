/**
 * Login / logout / forgot-password UI (Plan v5 task 48) over the auth-provider
 * seam. `<LoginForm>` collects credentials and calls `useAuth().login`, showing
 * the provider's error and a pending state; `<LogoutButton>` calls `logout`;
 * `<ForgotPasswordForm>` calls the provider's optional `forgotPassword`. All are
 * presentation over the seam — the backend is whatever the `AuthProvider`
 * implements — and use the shared primitives so they match the rest of the UI.
 */

import { type FormEvent, type ReactNode, useState } from 'react'
import { cn } from '../lib/cn.ts'
import { Button, Input, Label } from '../ui/primitives.tsx'
import { Alert } from '../ui/surfaces.tsx'
import { useAuth, useAuthProvider } from './auth-provider.tsx'

export interface LoginFormProps {
	/** Called after a successful login (navigate to the app / return URL). */
	onSuccess?: () => void
	/** Identifier field name + label (default email). */
	identifierField?: string
	identifierLabel?: string
	title?: ReactNode
	/** A slot under the form (e.g. a "Forgot password?" link). */
	footer?: ReactNode
	className?: string
}

export function LoginForm({
	onSuccess,
	identifierField = 'email',
	identifierLabel = 'Email',
	title = 'Sign in',
	footer,
	className,
}: LoginFormProps) {
	const { login } = useAuth()
	const [identifier, setIdentifier] = useState('')
	const [password, setPassword] = useState('')
	const [error, setError] = useState<string | null>(null)
	const [pending, setPending] = useState(false)

	async function onSubmit(e: FormEvent) {
		e.preventDefault()
		setError(null)
		setPending(true)
		try {
			await login({ [identifierField]: identifier, password })
			onSuccess?.()
		} catch (err) {
			setError(err instanceof Error ? err.message : 'Sign in failed')
		} finally {
			setPending(false)
		}
	}

	return (
		<form
			onSubmit={onSubmit}
			className={cn('flex w-full max-w-sm flex-col gap-4', className)}
			aria-label="Sign in"
		>
			{title ? <h1 className="font-semibold text-xl">{title}</h1> : null}
			{error ? (
				<Alert variant="destructive" role="alert">
					{error}
				</Alert>
			) : null}
			<div className="flex flex-col gap-1">
				<Label htmlFor="login-identifier">{identifierLabel}</Label>
				<Input
					id="login-identifier"
					name={identifierField}
					type={identifierField === 'email' ? 'email' : 'text'}
					autoComplete="username"
					value={identifier}
					onChange={(e) => setIdentifier(e.target.value)}
					required
				/>
			</div>
			<div className="flex flex-col gap-1">
				<Label htmlFor="login-password">Password</Label>
				<Input
					id="login-password"
					name="password"
					type="password"
					autoComplete="current-password"
					value={password}
					onChange={(e) => setPassword(e.target.value)}
					required
				/>
			</div>
			<Button type="submit" disabled={pending}>
				{pending ? 'Signing in…' : 'Sign in'}
			</Button>
			{footer}
		</form>
	)
}

export interface LogoutButtonProps {
	onSuccess?: () => void
	children?: ReactNode
	className?: string
}

export function LogoutButton({
	onSuccess,
	children = 'Sign out',
	className,
}: LogoutButtonProps) {
	const { logout } = useAuth()
	const [pending, setPending] = useState(false)
	return (
		<Button
			type="button"
			disabled={pending}
			className={className}
			onClick={async () => {
				setPending(true)
				try {
					await logout()
					onSuccess?.()
				} finally {
					setPending(false)
				}
			}}
		>
			{children}
		</Button>
	)
}

export interface ForgotPasswordFormProps {
	onSuccess?: () => void
	title?: ReactNode
	className?: string
}

export function ForgotPasswordForm({
	onSuccess,
	title = 'Reset your password',
	className,
}: ForgotPasswordFormProps) {
	const provider = useAuthProvider()
	const [email, setEmail] = useState('')
	const [sent, setSent] = useState(false)
	const [error, setError] = useState<string | null>(null)
	const [pending, setPending] = useState(false)

	async function onSubmit(e: FormEvent) {
		e.preventDefault()
		setError(null)
		if (!provider.forgotPassword) {
			setError('Password reset is not available.')
			return
		}
		setPending(true)
		try {
			await provider.forgotPassword(email)
			setSent(true)
			onSuccess?.()
		} catch (err) {
			setError(err instanceof Error ? err.message : 'Request failed')
		} finally {
			setPending(false)
		}
	}

	if (sent) {
		return (
			<output className={cn('block text-sm text-muted-foreground', className)}>
				If an account exists for {email}, a reset link is on its way.
			</output>
		)
	}

	return (
		<form
			onSubmit={onSubmit}
			className={cn('flex w-full max-w-sm flex-col gap-4', className)}
			aria-label="Reset password"
		>
			{title ? <h1 className="font-semibold text-xl">{title}</h1> : null}
			{error ? (
				<p role="alert" className="text-destructive text-sm">
					{error}
				</p>
			) : null}
			<div className="flex flex-col gap-1">
				<Label htmlFor="forgot-email">Email</Label>
				<Input
					id="forgot-email"
					type="email"
					autoComplete="username"
					value={email}
					onChange={(e) => setEmail(e.target.value)}
					required
				/>
			</div>
			<Button type="submit" disabled={pending}>
				{pending ? 'Sending…' : 'Send reset link'}
			</Button>
		</form>
	)
}
