/**
 * Default email templates.
 *
 * Subjects are lifted verbatim from the mxscratchpad originals
 * (`emails/templates/*.tsx`); bodies are reimplemented as minimal HTML strings
 * (the originals were `react-email` components — see the reference spec for why
 * the render contract was decoupled). `esc()` guards against attribute/text
 * injection from untrusted props.
 */

import type {
	EmailTemplate,
	MagicLinkProps,
	NewsletterConfirmationProps,
	NotificationDigestProps,
	NotificationEmailProps,
	PasswordResetProps,
	VerifyEmailProps,
	WelcomeEmailProps,
} from './types.ts'

const DEFAULT_COMPANY = 'Max'

/** Minimal HTML escaping for interpolated, possibly-untrusted values. */
function esc(value: string): string {
	return value
		.replace(/&/g, '&amp;')
		.replace(/</g, '&lt;')
		.replace(/>/g, '&gt;')
		.replace(/"/g, '&quot;')
		.replace(/'/g, '&#39;')
}

const layout = (heading: string, body: string): string =>
	`<!doctype html><html><body><h1>${esc(heading)}</h1>${body}</body></html>`

export const verifyEmailSubject = (props: VerifyEmailProps): string =>
	`Verify your email address for ${props.companyName || DEFAULT_COMPANY}`

export const verifyEmailTemplate: EmailTemplate<VerifyEmailProps> = {
	name: 'verify-email',
	subject: verifyEmailSubject,
	description: 'Email verification template for new user accounts',
	render: (props) =>
		layout(
			`Verify your email${props.name ? `, ${esc(props.name)}` : ''}`,
			`<p>Confirm ${esc(props.email)} to finish setting up your ${esc(
				props.companyName || DEFAULT_COMPANY,
			)} account.</p>` +
				`<p><a href="${esc(props.verificationUrl)}">Verify email address</a></p>`,
		),
}

export const passwordResetSubject = (props: PasswordResetProps): string =>
	`Reset your ${props.companyName || DEFAULT_COMPANY} password`

export const passwordResetTemplate: EmailTemplate<PasswordResetProps> = {
	name: 'password-reset',
	subject: passwordResetSubject,
	description: 'Password reset template for existing users',
	render: (props) =>
		layout(
			'Reset your password',
			`<p>We received a request to reset the password for ${esc(props.email)}.</p>` +
				`<p><a href="${esc(props.resetUrl)}">Reset password</a></p>`,
		),
}

export const magicLinkSubject = (props: MagicLinkProps): string =>
	`Sign in to ${props.companyName || DEFAULT_COMPANY}`

export const magicLinkTemplate: EmailTemplate<MagicLinkProps> = {
	name: 'magic-link',
	subject: magicLinkSubject,
	description: 'Passwordless sign-in link',
	render: (props) =>
		layout(
			`Sign in${props.name ? `, ${esc(props.name)}` : ''}`,
			`<p>Use the link below to sign in as ${esc(props.email)}. It expires shortly and can be used once.</p>` +
				`<p><a href="${esc(props.magicLinkUrl)}">Sign in to ${esc(
					props.companyName || DEFAULT_COMPANY,
				)}</a></p>`,
		),
}

export const welcomeEmailSubject = (props: WelcomeEmailProps): string =>
	`Welcome to ${props.companyName || DEFAULT_COMPANY}! Your account is ready.`

export const welcomeEmailTemplate: EmailTemplate<WelcomeEmailProps> = {
	name: 'welcome',
	subject: welcomeEmailSubject,
	description: 'Welcome email template for verified users',
	render: (props) =>
		layout(
			`Welcome, ${esc(props.name)}!`,
			`<p>Your ${esc(props.companyName || DEFAULT_COMPANY)} account is ready.</p>` +
				(props.dashboardUrl
					? `<p><a href="${esc(props.dashboardUrl)}">Open your dashboard</a></p>`
					: ''),
		),
}

export const newsletterConfirmationSubject = (
	props: NewsletterConfirmationProps,
): string =>
	`Confirm your ${props.companyName || DEFAULT_COMPANY} newsletter subscription`

export const newsletterConfirmationTemplate: EmailTemplate<NewsletterConfirmationProps> =
	{
		name: 'newsletter-confirmation',
		subject: newsletterConfirmationSubject,
		description: 'Newsletter subscription confirmation template',
		render: (props) =>
			layout(
				'Confirm your subscription',
				`<p>Confirm ${esc(props.email)} to start receiving the ${esc(
					props.companyName || DEFAULT_COMPANY,
				)} newsletter.</p>` +
					`<p><a href="${esc(props.confirmationUrl)}">Confirm subscription</a></p>`,
			),
	}

/** The one-click opt-out footer. Rendered whenever a caller supplies a link;
 * `NotificationService` is the thing that makes sure one is supplied for every
 * message that legally needs it. */
const unsubscribeFooter = (url: string | undefined): string =>
	url
		? `<hr /><p style="font-size:12px;color:#666">` +
			`<a href="${esc(url)}">Unsubscribe from these emails</a></p>`
		: ''

export const notificationSubject = (props: NotificationEmailProps): string =>
	props.title

export const notificationTemplate: EmailTemplate<NotificationEmailProps> = {
	name: 'notification',
	subject: notificationSubject,
	description: 'A single in-app-notification event, mirrored as email',
	render: (props) =>
		layout(
			props.title,
			`<p>${esc(props.body)}</p>` +
				(props.url ? `<p><a href="${esc(props.url)}">View</a></p>` : '') +
				unsubscribeFooter(props.unsubscribeUrl),
		),
}

export const notificationDigestSubject = (
	props: NotificationDigestProps,
): string =>
	`${props.items.length} update${props.items.length === 1 ? '' : 's'} from ${
		props.companyName || DEFAULT_COMPANY
	}`

export const notificationDigestTemplate: EmailTemplate<NotificationDigestProps> =
	{
		name: 'notification-digest',
		subject: notificationDigestSubject,
		description: 'A batched summary of queued digest notifications',
		render: (props) =>
			layout(
				'Your digest',
				`<ul>${props.items
					.map(
						(item) =>
							`<li><strong>${esc(item.title)}</strong> — ${esc(item.body)}</li>`,
					)
					.join('')}</ul>${unsubscribeFooter(props.unsubscribeUrl)}`,
			),
	}

/** The templates every registry starts with. */
export const defaultTemplates: Record<string, EmailTemplate<any>> = {
	'verify-email': verifyEmailTemplate,
	'password-reset': passwordResetTemplate,
	'magic-link': magicLinkTemplate,
	welcome: welcomeEmailTemplate,
	'newsletter-confirmation': newsletterConfirmationTemplate,
	notification: notificationTemplate,
	'notification-digest': notificationDigestTemplate,
}
