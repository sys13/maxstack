import { betterAuth } from 'better-auth'
import { drizzleAdapter } from 'better-auth/adapters/drizzle'
import { db } from '~/utils/db.server'
import * as schema from '../../database/_schema'
import { sendEmail } from './email.server'

export const auth = betterAuth({
	database: drizzleAdapter(db, {
		provider: 'sqlite',
		schema,
	}),
	emailAndPassword: {
		enabled: true,
		autoSignInAfterVerification: true,
		requireEmailVerification: true,
		sendOnSignUp: true,
		sendResetPassword: async ({ user, url }) => {
			await sendEmail({
				to: user.email,
				subject: 'Reset your password',
				text: `Click the link to reset your password: ${url}`,
				html: `<p>Click the link to reset your password: <a href="${url}">${url}</a></p>`,
			})
		},
	},
	emailVerification: {
		sendVerificationEmail: async ({ user, url }) => {
			await sendEmail({
				to: user.email,
				subject: 'Verify your email address',
				text: `Click the link to verify your email: ${url}`,
				html: `<p>Click the link to verify your email: <a href="${url}">${url}</a></p>`,
			})
		},
	},
})
