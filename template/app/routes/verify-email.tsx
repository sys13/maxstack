import { PageContainer } from '~/components/page-container'

export default function VerifyEmail() {
	return (
		<PageContainer>
			<div className="w-full flex flex-col items-center min-h-screen">
				<h1 className="text-3xl font-bold mb-4">Verify Your Email</h1>
				<p className="mb-6 text-center max-w-md">
					We have sent a verification link to your email address. Please check
					your inbox and click the link to verify your account.
				</p>
				<p className="text-sm text-gray-500">
					If you did not receive the email, please check your spam folder or
					request a new verification email.
				</p>
			</div>
		</PageContainer>
	)
}
