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
import { useState } from 'react'
import { Form, Link } from 'react-router'
import { PageContainer } from '~/components/page-container'
import { authClient } from '~/lib/auth-client'

export default function ForgotPassword() {
	const [email, setEmail] = useState('')
	const [formError, setFormError] = useState<string | null>(null)
	const [loading, setLoading] = useState(false)
	const [success, setSuccess] = useState(false)

	const handleForgotPassword = async () => {
		setFormError(null)
		setLoading(true)

		try {
			await authClient.forgetPassword({
				email,
				redirectTo: '/reset-password',
			})
			setSuccess(true)
		} catch (error) {
			setFormError(
				error instanceof Error
					? error.message
					: 'An error occurred while sending the reset email',
			)
		} finally {
			setLoading(false)
		}
	}

	if (success) {
		return (
			<PageContainer>
				<div className={cn('flex flex-col gap-6 items-center')}>
					<Card className="w-full max-w-md">
						<CardHeader className="text-center">
							<CardTitle className="text-xl">Check your email</CardTitle>
							<CardDescription>
								We've sent a password reset link to {email}
							</CardDescription>
						</CardHeader>
						<CardContent>
							<div className="grid gap-6">
								<div className="text-center text-sm">
									<Link to="/login" className="underline underline-offset-4">
										Back to Login
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
		<div className={cn('flex flex-col gap-6 items-center')}>
			<Card className="w-full max-w-md">
				<CardHeader className="text-center">
					<CardTitle className="text-xl">Reset your password</CardTitle>
					<CardDescription>
						Enter your email address and we'll send you a link to reset your
						password
					</CardDescription>
				</CardHeader>
				<CardContent>
					<Form
						onSubmit={(e) => {
							e.preventDefault()
							handleForgotPassword()
						}}
					>
						<div className="grid gap-6">
							<div className="grid gap-3">
								<Label htmlFor="email">Email</Label>
								<Input
									id="email"
									type="email"
									placeholder="m@example.com"
									required
									value={email}
									onChange={(e) => setEmail(e.target.value)}
								/>
							</div>
							<Button type="submit" className="w-full" disabled={loading}>
								{loading ? 'Sending...' : 'Send reset link'}
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
	)
}
