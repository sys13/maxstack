import { Button } from '@/components/ui/button'
import {
	Card,
	CardContent,
	CardDescription,
	CardHeader,
	CardTitle,
} from '@/components/ui/card'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { cn } from '@/lib/utils'
import { useEffect, useState } from 'react'
import { Form, Link, useLocation } from 'react-router'
import { PageContainer } from '~/components/page-container'
import { authClient } from '~/lib/auth-client'

export default function ResetPassword() {
	const [password, setPassword] = useState('')
	const [confirmPassword, setConfirmPassword] = useState('')
	const [formError, setFormError] = useState<string | null>(null)
	const [loading, setLoading] = useState(false)
	const [success, setSuccess] = useState(false)
	const location = useLocation()

	// Extract token from URL search params
	const searchParams = new URLSearchParams(location.search)
	const token = searchParams.get('token')

	useEffect(() => {
		if (!token) {
			setFormError('Invalid or missing reset token')
		}
	}, [token])

	const handleResetPassword = async () => {
		if (!token) {
			setFormError('Invalid reset token')
			return
		}

		if (password !== confirmPassword) {
			setFormError('Passwords do not match')
			return
		}

		if (password.length < 8) {
			setFormError('Password must be at least 8 characters long')
			return
		}

		setFormError(null)
		setLoading(true)

		try {
			await authClient.resetPassword({
				newPassword: password,
				token,
			})
			setSuccess(true)
		} catch (error) {
			setFormError(
				error instanceof Error
					? error.message
					: 'An error occurred while resetting your password',
			)
		} finally {
			setLoading(false)
		}
	}

	if (success) {
		return (
			<PageContainer>
				<div className={cn('flex flex-col gap-6 items-center')}>
					<Card className="w-full">
						<CardHeader className="text-center">
							<CardTitle className="text-xl">
								Password reset successful
							</CardTitle>
							<CardDescription>
								Your password has been successfully reset
							</CardDescription>
						</CardHeader>
						<CardContent>
							<div className="grid gap-6">
								<div className="text-center text-sm">
									<Link to="/login" className="underline underline-offset-4">
										Login with your new password
									</Link>
								</div>
							</div>
						</CardContent>
					</Card>
				</div>
			</PageContainer>
		)
	}

	if (!token) {
		return (
			<PageContainer>
				<div className={cn('flex flex-col gap-6 items-center')}>
					<Card className="w-full">
						<CardHeader className="text-center">
							<CardTitle className="text-xl">Invalid Reset Link</CardTitle>
							<CardDescription>
								This password reset link is invalid or has expired
							</CardDescription>
						</CardHeader>
						<CardContent>
							<div className="grid gap-6">
								<div className="text-center text-sm">
									<Link
										to="/forgot-password"
										className="underline underline-offset-4"
									>
										Request a new reset link
									</Link>
								</div>
							</div>
						</CardContent>
					</Card>
				</div>
			</PageContainer>
		)
	}

	return (
		<PageContainer>
			<div className={cn('flex flex-col gap-6 items-center')}>
				<Card className="w-full">
					<CardHeader className="text-center">
						<CardTitle className="text-xl">Set new password</CardTitle>
						<CardDescription>Enter your new password below</CardDescription>
					</CardHeader>
					<CardContent>
						<Form
							onSubmit={(e) => {
								e.preventDefault()
								handleResetPassword()
							}}
						>
							<div className="grid gap-6">
								<div className="grid gap-3">
									<Label htmlFor="password">New Password</Label>
									<Input
										id="password"
										type="password"
										required
										value={password}
										onChange={(e) => setPassword(e.target.value)}
										minLength={8}
									/>
								</div>
								<div className="grid gap-3">
									<Label htmlFor="confirmPassword">Confirm New Password</Label>
									<Input
										id="confirmPassword"
										type="password"
										required
										value={confirmPassword}
										onChange={(e) => setConfirmPassword(e.target.value)}
										minLength={8}
									/>
								</div>
								<Button type="submit" className="w-full" disabled={loading}>
									{loading ? 'Resetting...' : 'Reset password'}
								</Button>
								{formError && (
									<div className="text-red-500 text-sm text-center">
										{formError}
									</div>
								)}
								<div className="text-center text-sm">
									<Link to="/login" className="underline underline-offset-4">
										Back to Login
									</Link>
								</div>
							</div>
						</Form>
					</CardContent>
				</Card>
			</div>
		</PageContainer>
	)
}
