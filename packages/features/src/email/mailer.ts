/**
 * Mailer transport — the piece the email registry was deliberately decoupled
 * from (see `types.ts`: the original coupled templates to `react-email` + a
 * `~/lib/email.server` transport). The registry renders a template to an HTML
 * body; the transport *sends* it. Keeping them separate is the salvaged
 * decision; this module supplies the transport seam plus two dependency-light
 * implementations, so the feature is usable end-to-end without pulling in
 * react-email or an SMTP/provider SDK.
 *
 * Deferred (documented in the design as build-vs-deferred): react-email
 * component bodies and a real SMTP / provider (SES/Resend/…) transport. Those
 * are drop-in `Mailer` implementations + a richer `render` — the contract here
 * is exactly what they'd satisfy.
 */

import type { EmailRegistry } from './registry.ts'

/**
 * A file riding along with a message.
 *
 * A general email capability, not a document one: a receipt, a monthly report
 * and a CSV export all want it, and nothing here knows what a document is. That
 * separation is the point asked for document generation to be a
 * proof that bundles compose, and the evidence is that composing it with `email`
 * cost this bundle one field rather than a `renderDocument` call.
 */
export interface EmailAttachment {
	filename: string
	contentType: string
	bytes: Uint8Array
}

/** A ready-to-send message: a rendered template plus its recipient. */
export interface OutgoingEmail {
	to: string
	subject: string
	/** The rendered HTML body. */
	html: string
	from?: string
	/**
	 * Files to attach. Optional, and a transport that cannot attach must say so
	 * rather than drop them — see {@link createConsoleMailer}, which logs them,
	 * and the note on {@link Mailer}.
	 */
	attachments?: EmailAttachment[]
}

/** The outcome of a send — an id the transport assigns, for logging/retry. */
export interface SentMessage {
	id: string
	to: string
	subject: string
}

/**
 * A transport that delivers a rendered email. Injected as the `mailer` binding.
 *
 * A transport that cannot carry {@link OutgoingEmail.attachments} must **throw**
 * rather than send the message without them. Silently dropping an attachment
 * sends a customer an email whose body says "your invoice is attached" and has
 * nothing attached, and nothing anywhere reports a failure.
 */
export interface Mailer {
	send(email: OutgoingEmail): Promise<SentMessage>
}

/**
 * Render a registered template to a subject + HTML body. Throws if the template
 * is not registered (a caller asked for an email that doesn't exist).
 */
export function renderEmail<P>(
	registry: EmailRegistry,
	name: string,
	props: P,
): { subject: string; html: string } {
	const template = registry.get(name)
	if (!template) throw new Error(`unknown email template "${name}"`)
	return {
		subject: template.subject(props as never),
		html: template.render(props as never),
	}
}

/**
 * A mailer that logs each message instead of sending it — the safe default for
 * local dev, where a real transport isn't configured. Ids are deterministic per
 * process (a counter), so logs are stable and tests can assert on them.
 */
export function createConsoleMailer(
	log: (msg: string) => void = console.log,
): Mailer {
	let n = 0
	return {
		async send(email) {
			const id = `console-${++n}`
			const files = email.attachments?.length
				? ` · ${email.attachments.map((a) => `${a.filename} (${a.bytes.length}B)`).join(', ')}`
				: ''
			log(`[email:${id}] → ${email.to} · ${email.subject}${files}`)
			return { id, to: email.to, subject: email.subject }
		},
	}
}

/**
 * An in-memory mailer that collects sent messages — a test double and a sink for
 * previews. `sent` exposes every message the transport received.
 */
export function createMemoryMailer(): Mailer & {
	sent: (OutgoingEmail & SentMessage)[]
} {
	const sent: (OutgoingEmail & SentMessage)[] = []
	const mailer: Mailer = {
		async send(email) {
			const id = `mem-${sent.length + 1}`
			const record = { ...email, id, to: email.to, subject: email.subject }
			sent.push(record)
			return { id, to: email.to, subject: email.subject }
		},
	}
	return Object.assign(mailer, { sent })
}
