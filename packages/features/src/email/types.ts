/**
 * Email feature — types.
 *
 * Reimplemented from mxscratchpad's `emails/types.ts`. The salvaged decision
 * is the *registry* (a name-keyed template store with custom-over-default override);
 * the original coupled templates to `react-email` + a `~/lib/email.server`
 * transport. This staging keeps the registry decision and reimplements the
 * template contract as a dependency-free `render(props) => string` (HTML),
 * so the feature is runtime-usable and testable without React or a mailer.
 */

/** A template's rendered output: an HTML body (transport-agnostic). */
export interface EmailTemplate<P = Record<string, unknown>> {
	name: string
	/** Compute the subject line from the props. */
	subject: (props: P) => string
	/** Render the HTML body from the props. */
	render: (props: P) => string
	description?: string
}

export interface VerifyEmailProps {
	name?: string
	email: string
	verificationUrl: string
	companyName?: string
	supportEmail?: string
}

export interface MagicLinkProps {
	name?: string
	email: string
	magicLinkUrl: string
	companyName?: string
	supportEmail?: string
}

export interface PasswordResetProps {
	name?: string
	email: string
	resetUrl: string
	companyName?: string
	supportEmail?: string
}

export interface WelcomeEmailProps {
	name: string
	email: string
	companyName?: string
	dashboardUrl?: string
	supportEmail?: string
}

export interface NewsletterConfirmationProps {
	email: string
	confirmationUrl: string
	companyName?: string
	unsubscribeUrl?: string
}

/** A single in-app-notification event, mirrored as email
 * (task 56's `NotificationService.notify`).
 *
 * `unsubscribeUrl` is optional here and *not* optional in practice: the service
 * refuses to send an opt-out-able type without one. It stays
 * optional in the type because a transactional message — a password reset —
 * legitimately has none. */
export interface NotificationEmailProps {
	title: string
	body: string
	url?: string
	companyName?: string
	unsubscribeUrl?: string
}

/** A batch of queued notifications, mailed as one digest
 * (task 56's `NotificationService.sendDigest`). */
export interface NotificationDigestProps {
	items: { title: string; body: string }[]
	companyName?: string
	unsubscribeUrl?: string
}
