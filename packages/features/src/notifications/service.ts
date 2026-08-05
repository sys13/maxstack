/**
 * `NotificationService` — the in-app inbox plus delivery over the `email`
 * bundle, rebuilt in issue #184 around three things the original did not have.
 *
 * **1. Declared types.** `notify()` no longer takes a free-form string and a
 * per-call-site category. It takes a key from the declared vocabulary
 * (`types.ts`), and *how loud* the message is comes from the declaration plus
 * the recipient's preference — never from the sender. That inversion is the
 * whole trust argument: the cheapest thing to write at a call site can no longer
 * be "email everyone immediately".
 *
 * **2. Idempotent delivery.** Digests run on a job queue and job queues are
 * at-least-once, so a handler will be re-run with the same input. Every delivery
 * is therefore a *claim*: the row is written first, under a unique
 * `(user_id, dedupe_key)`, and only the writer that won the insert sends. A
 * redelivery finds the claim and stops. The one case it does *not* stop is a
 * claim that was never mailed (`emailed = false`) — that is a run that died
 * before the send, and refusing it would turn at-least-once into at-most-once.
 *
 * **3. Content that cannot outlive access.** A notification names the row it is
 * about, and the recipient's ability to read that row is re-checked at *every*
 * point content is rendered — the immediate email, the inbox listing, and the
 * digest. A permission removed after the notification was created removes the
 * content with it, which is a thing digests get wrong precisely because the
 * content is assembled long after the event.
 *
 * Preferences resolve user → organization → declaration, so an
 * organization can steer defaults and a member always wins over them.
 */

import { and, desc, eq } from 'drizzle-orm'
import type { drizzle } from 'drizzle-orm/pglite'
import type { Mailer } from '../email/mailer.ts'
import { renderEmail } from '../email/mailer.ts'
import type { EmailRegistry } from '../email/registry.ts'
import type { PreferencesService } from '../preferences/service.ts'
import { notification, notificationDigest } from './schema.ts'
import {
	BUILT_IN_NOTIFICATION_TYPES,
	DIGEST_CADENCE_PREFERENCE,
	type DigestCadence,
	type EmailDelivery,
	emailPreferenceKey,
	inAppPreferenceKey,
	isOptOutable,
	type NotificationTypeDefinition,
	notificationTypeErrors,
} from './types.ts'
import type { UnsubscribeConfig } from './unsubscribe.ts'
import { unsubscribeUrl, verifyUnsubscribeToken } from './unsubscribe.ts'

/** The account-wide channel switches (declared in `BUILT_IN_PREFERENCES`). */
const EMAIL_NOTIFICATIONS = 'email-notifications'
const IN_APP_NOTIFICATIONS = 'in-app-notifications'

type Db = ReturnType<typeof drizzle>

/** The row a notification is about, for the read-access re-check. */
export interface NotificationSubject {
	resource: string
	id: string
}

/**
 * "May this user read this row?" — supplied by the app, because only the app
 * knows its own authorization rules. The default answers `true`, which is safe
 * only because a notification with no `subject` claims to be about no row.
 */
export type NotificationVisibility = (opts: {
	userId: string
	subject: NotificationSubject
}) => boolean | Promise<boolean>

export interface Notification {
	id: string
	userId: string
	type: string
	title: string
	body: string
	url: string | null
	category: 'immediate' | 'digest' | 'none'
	inApp: boolean
	read: boolean
	emailed: boolean
	dedupeKey: string
	subjectResource: string | null
	subjectId: string | null
	createdAt: Date
}

export interface NotifyInput {
	userId: string
	/** A key from the declared vocabulary. An undeclared key is an error, not a
	 * new type — see `types.ts`. */
	type: string
	title: string
	body: string
	url?: string
	/** Where email goes. Preferences do not carry an address; the caller resolves
	 * it (the app template's `resolveEmail`). */
	email?: string
	/** The row this is about. Supply it whenever the title or body says anything
	 * about a row — it is what lets delivery re-check read access. */
	subject?: NotificationSubject
	/**
	 * Idempotency key, unique per user. Supply a value derived from the *event*
	 * (`invite-accepted:${inviteId}`) whenever the caller may run more than once;
	 * omitted, every call is a distinct delivery.
	 */
	dedupeKey?: string
	/** Overrides the declared template's props; defaults to `{ title, body, url }`. */
	emailProps?: Record<string, unknown>
}

export interface NotifyResult {
	/** The delivery row's id — `null` only when nothing was recorded. */
	id: string | null
	inApp: boolean
	emailed: boolean
	queuedForDigest: boolean
	/** True when this exact delivery had already been claimed. */
	duplicate: boolean
	/** Why nothing was delivered, when nothing was. */
	suppressed: 'visibility' | null
}

export interface DigestResult {
	sent: boolean
	count: number
	/** True when another run had already mailed this window. */
	duplicate: boolean
	/** Items withheld because the recipient can no longer read the row. */
	withheld: number
}

export class UnknownNotificationTypeError extends Error {
	constructor(key: string) {
		super(
			`Unknown notification type "${key}". Declare it in the service's types ` +
				'so it ships with its own opt-out.',
		)
		this.name = 'UnknownNotificationTypeError'
	}
}

export class MissingUnsubscribeConfigError extends Error {
	constructor(typeKey: string) {
		super(
			`Refusing to email notification type "${typeKey}": it is opt-out-able, so ` +
				'the message needs an unsubscribe link, and no unsubscribe config was ' +
				'given to NotificationService.',
		)
		this.name = 'MissingUnsubscribeConfigError'
	}
}

let counter = 0
const nextId = (prefix: string) =>
	`${prefix}-${Date.now().toString(36)}-${++counter}`

/** The window a digest covers, as a stable key: `2026-07-27` daily, `2026-W30`
 * weekly. Two runs inside one window claim the same key, which is what makes
 * the claim table able to suppress the second. */
export function digestWindowKey(cadence: DigestCadence, now: Date): string {
	const iso = now.toISOString()
	if (cadence === 'daily') return iso.slice(0, 10)
	// ISO week: Thursday of the current week decides the year and week number.
	const date = new Date(
		Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()),
	)
	const day = date.getUTCDay() || 7
	date.setUTCDate(date.getUTCDate() + 4 - day)
	const yearStart = new Date(Date.UTC(date.getUTCFullYear(), 0, 1))
	const week = Math.ceil(
		((date.getTime() - yearStart.getTime()) / 86_400_000 + 1) / 7,
	)
	return `${date.getUTCFullYear()}-W${String(week).padStart(2, '0')}`
}

export interface NotificationServiceOptions {
	db: Db
	mailer: Mailer
	registry: EmailRegistry
	preferences: PreferencesService
	/** Declared types. Defaults to {@link BUILT_IN_NOTIFICATION_TYPES}; pass the
	 * app's own list (built-ins spread in) to add product-specific ones. */
	types?: readonly NotificationTypeDefinition[]
	/** Read-access check for a notification's subject row. */
	visibility?: NotificationVisibility
	/** Required to email anything opt-out-able — see
	 * {@link MissingUnsubscribeConfigError}. */
	unsubscribe?: UnsubscribeConfig
	companyName?: string
	now?: () => Date
}

export class NotificationService {
	private readonly db: Db
	private readonly mailer: Mailer
	private readonly registry: EmailRegistry
	private readonly preferences: PreferencesService
	private readonly types: Map<string, NotificationTypeDefinition>
	private readonly visibility: NotificationVisibility
	private readonly unsubscribeConfig: UnsubscribeConfig | undefined
	private readonly companyName: string | undefined
	private readonly now: () => Date

	constructor(opts: NotificationServiceOptions) {
		this.db = opts.db
		this.mailer = opts.mailer
		this.registry = opts.registry
		this.preferences = opts.preferences
		const types = opts.types ?? BUILT_IN_NOTIFICATION_TYPES
		const errors = notificationTypeErrors(types)
		if (errors.length)
			throw new Error(`Invalid notification types:\n- ${errors.join('\n- ')}`)
		this.types = new Map(types.map((t) => [t.key, t]))
		this.visibility = opts.visibility ?? (() => true)
		this.unsubscribeConfig = opts.unsubscribe
		this.companyName = opts.companyName
		this.now = opts.now ?? (() => new Date())
	}

	/** The declared vocabulary, in declaration order. */
	listTypes(): NotificationTypeDefinition[] {
		return [...this.types.values()]
	}

	definition(key: string): NotificationTypeDefinition | undefined {
		return this.types.get(key)
	}

	/**
	 * How one recipient receives one type right now: the declaration, narrowed by
	 * the account-wide channel switches and then by the per-type preference.
	 * Exposed because "why did I not get that email" is the question this feature
	 * gets asked, and answering it by reading two tables in a console is not an
	 * answer.
	 */
	async deliveryFor(
		userId: string,
		typeKey: string,
		organizationId?: string | null,
	): Promise<{ email: EmailDelivery; inApp: boolean }> {
		const def = this.types.get(typeKey)
		if (!def) throw new UnknownNotificationTypeError(typeKey)
		const prefs = await this.preferences.resolve({ userId, organizationId })

		const inApp =
			prefs.bool(IN_APP_NOTIFICATIONS) &&
			(prefs.get(inAppPreferenceKey(def.key)) as boolean | undefined) !== false

		if (!prefs.bool(EMAIL_NOTIFICATIONS)) return { email: 'off', inApp }
		if (!isOptOutable(def)) return { email: 'immediate', inApp }
		const chosen = prefs.string(emailPreferenceKey(def.key), def.defaultEmail)
		const email: EmailDelivery =
			chosen === 'immediate' || chosen === 'digest' || chosen === 'off'
				? chosen
				: def.defaultEmail
		return { email, inApp }
	}

	/**
	 * Deliver one event.
	 *
	 * Order matters and is not incidental: read access first (nothing is recorded
	 * about a row the recipient cannot read), then the claim, then the send. A
	 * send that happens before the claim is a send that can happen twice.
	 */
	async notify(
		input: NotifyInput,
		opts: { organizationId?: string | null } = {},
	): Promise<NotifyResult> {
		const def = this.types.get(input.type)
		if (!def) throw new UnknownNotificationTypeError(input.type)

		if (input.subject && !(await this.canSee(input.userId, input.subject))) {
			return {
				id: null,
				inApp: false,
				emailed: false,
				queuedForDigest: false,
				duplicate: false,
				suppressed: 'visibility',
			}
		}

		const delivery = await this.deliveryFor(
			input.userId,
			def.key,
			opts.organizationId,
		)
		const category: Notification['category'] =
			delivery.email === 'immediate'
				? 'immediate'
				: delivery.email === 'digest'
					? 'digest'
					: 'none'

		const id = nextId('ntf')
		const dedupeKey = input.dedupeKey ?? id
		const claim = await this.claim({
			id,
			userId: input.userId,
			type: def.key,
			title: input.title,
			body: input.body,
			url: input.url ?? null,
			category,
			inApp: delivery.inApp,
			dedupeKey,
			subjectResource: input.subject?.resource ?? null,
			subjectId: input.subject?.id ?? null,
			createdAt: this.now(),
		})

		// An existing claim that was already mailed (or was never going to be) is
		// a duplicate and stops here. One that has not been mailed is a retry of a
		// run that died before sending, and is allowed to finish the send.
		const alreadyHandled =
			!claim.fresh && (claim.row.emailed || claim.row.category !== 'immediate')
		if (alreadyHandled) {
			return {
				id: claim.row.id,
				inApp: claim.row.inApp,
				emailed: claim.row.emailed,
				queuedForDigest: claim.row.category === 'digest',
				duplicate: true,
				suppressed: null,
			}
		}

		let emailed = false
		if (claim.row.category === 'immediate' && input.email) {
			await this.sendOne(def, claim.row, input, input.email)
			await this.db
				.update(notification)
				.set({ emailed: true })
				.where(eq(notification.id, claim.row.id))
			emailed = true
		}

		return {
			id: claim.row.id,
			inApp: claim.row.inApp,
			emailed,
			queuedForDigest: claim.row.category === 'digest',
			duplicate: !claim.fresh,
			suppressed: null,
		}
	}

	/**
	 * The inbox. Rows whose subject the user can no longer read are filtered
	 * here, not just in email: an inbox is a rendering of content too, and a
	 * notification that outlives access leaks in exactly the same way.
	 */
	async listNotifications(
		userId: string,
		opts: { unreadOnly?: boolean } = {},
	): Promise<Notification[]> {
		const rows = (await this.db
			.select()
			.from(notification)
			.where(and(eq(notification.userId, userId), eq(notification.inApp, true)))
			.orderBy(desc(notification.createdAt))) as Notification[]
		const visible = await this.filterVisible(userId, rows)
		return opts.unreadOnly ? visible.filter((r) => !r.read) : visible
	}

	async unreadCount(userId: string): Promise<number> {
		const rows = await this.listNotifications(userId, { unreadOnly: true })
		return rows.length
	}

	/** Scoped to `userId` — an id from another user's inbox is a no-op, not an error. */
	async markRead(id: string, userId: string): Promise<void> {
		await this.db
			.update(notification)
			.set({ read: true })
			.where(and(eq(notification.id, id), eq(notification.userId, userId)))
	}

	async markAllRead(userId: string): Promise<void> {
		await this.db
			.update(notification)
			.set({ read: true })
			.where(eq(notification.userId, userId))
	}

	/**
	 * Batch a user's pending digest rows into one email.
	 *
	 * Idempotent by construction: the (user, window) pair is claimed before
	 * anything is rendered, so the second worker to pick up the same job finds a
	 * sent claim and returns `duplicate`. `windowKey` defaults to the window the
	 * recipient's cadence preference puts `now` in, which is what makes two
	 * *unsynchronized* runs inside one day collapse as well as two copies of one
	 * job.
	 */
	async sendDigest(
		userId: string,
		email: string,
		opts: { windowKey?: string; organizationId?: string | null } = {},
	): Promise<DigestResult> {
		const prefs = await this.preferences.resolve({
			userId,
			organizationId: opts.organizationId,
		})
		const cadence = (
			prefs.string(DIGEST_CADENCE_PREFERENCE, 'daily') === 'weekly'
				? 'weekly'
				: 'daily'
		) satisfies DigestCadence
		const windowKey = opts.windowKey ?? digestWindowKey(cadence, this.now())

		const nothing = { sent: false, count: 0, duplicate: false, withheld: 0 }
		if (!prefs.bool(EMAIL_NOTIFICATIONS)) return nothing

		const pending = (
			(await this.db
				.select()
				.from(notification)
				.where(
					and(
						eq(notification.userId, userId),
						eq(notification.category, 'digest'),
						eq(notification.emailed, false),
					),
				)
				.orderBy(desc(notification.createdAt))) as Notification[]
		).filter(
			// A type the recipient has since turned off (or turned up to immediate)
			// does not ride along in a digest queued under the old preference.
			(row) => {
				const def = this.types.get(row.type)
				if (!def) return false
				if (!isOptOutable(def)) return true
				return (
					prefs.string(emailPreferenceKey(def.key), def.defaultEmail) !== 'off'
				)
			},
		)
		if (pending.length === 0) return nothing

		const visible = await this.filterVisible(userId, pending)
		const withheld = pending.length - visible.length
		if (visible.length === 0) return { ...nothing, withheld }

		const claim = await this.claimDigestWindow(userId, windowKey)
		if (!claim.proceed)
			return { sent: false, count: 0, duplicate: true, withheld }

		const { subject, html } = renderEmail(
			this.registry,
			'notification-digest',
			{
				items: visible.map((r) => ({ title: r.title, body: r.body })),
				...(this.companyName ? { companyName: this.companyName } : {}),
				// A digest is opt-out-able by definition — it exists because someone
				// chose not to be mailed immediately.
				unsubscribeUrl: this.unsubscribeLink(userId, { kind: 'all' }, 'digest'),
			},
		)
		await this.mailer.send({ to: email, subject, html })

		for (const row of visible) {
			await this.db
				.update(notification)
				.set({ emailed: true })
				.where(eq(notification.id, row.id))
		}
		await this.db
			.update(notificationDigest)
			.set({ sentAt: this.now(), itemCount: visible.length })
			.where(eq(notificationDigest.id, claim.id))

		return { sent: true, count: visible.length, duplicate: false, withheld }
	}

	/**
	 * Apply an unsubscribe link. Returns what changed, or why nothing did — a
	 * route renders this, and "that link is no longer valid" is a better page
	 * than a 500.
	 */
	async unsubscribe(
		token: string,
	): Promise<
		| { ok: true; userId: string; scope: 'all' | string; label: string }
		| { ok: false; reason: 'invalid-token' | 'unknown-type' | 'not-optional' }
	> {
		if (!this.unsubscribeConfig) return { ok: false, reason: 'invalid-token' }
		const payload = verifyUnsubscribeToken(this.unsubscribeConfig.secret, token)
		if (!payload) return { ok: false, reason: 'invalid-token' }

		const actor = { id: payload.userId }
		if (payload.scope.kind === 'all') {
			await this.preferences.setUserPreferences(actor, payload.userId, {
				[EMAIL_NOTIFICATIONS]: false,
			})
			return {
				ok: true,
				userId: payload.userId,
				scope: 'all',
				label: 'all notification email',
			}
		}

		const def = this.types.get(payload.scope.type)
		if (!def) return { ok: false, reason: 'unknown-type' }
		if (!isOptOutable(def)) return { ok: false, reason: 'not-optional' }
		await this.preferences.setUserPreferences(actor, payload.userId, {
			[emailPreferenceKey(def.key)]: 'off',
		})
		return {
			ok: true,
			userId: payload.userId,
			scope: def.key,
			label: def.label,
		}
	}

	// -----------------------------------------------------------------------
	// internals
	// -----------------------------------------------------------------------

	/** Insert the delivery row, or return the row that already claimed the key. */
	private async claim(
		row: Omit<Notification, 'read' | 'emailed'>,
	): Promise<{ row: Notification; fresh: boolean }> {
		const inserted = (await this.db
			.insert(notification)
			.values(row)
			.onConflictDoNothing({
				target: [notification.userId, notification.dedupeKey],
			})
			.returning()) as Notification[]
		const fresh = inserted[0]
		if (fresh) return { row: fresh, fresh: true }

		const [existing] = (await this.db
			.select()
			.from(notification)
			.where(
				and(
					eq(notification.userId, row.userId),
					eq(notification.dedupeKey, row.dedupeKey),
				),
			)) as Notification[]
		// Losing the insert and then not finding the row would mean the conflict
		// came from somewhere else entirely; treating that as fresh would send.
		if (!existing)
			throw new Error(
				`notification claim for "${row.dedupeKey}" conflicted but no row was found`,
			)
		return { row: existing, fresh: false }
	}

	/**
	 * Claim a digest window. `proceed` is false only when a previous run already
	 * *sent* this window; a claim that was never sent belongs to a run that died,
	 * and is handed back so the digest is not lost.
	 */
	private async claimDigestWindow(
		userId: string,
		windowKey: string,
	): Promise<{ proceed: boolean; id: string }> {
		const id = nextId('dig')
		const inserted = await this.db
			.insert(notificationDigest)
			.values({ id, userId, windowKey, claimedAt: this.now(), itemCount: 0 })
			.onConflictDoNothing({
				target: [notificationDigest.userId, notificationDigest.windowKey],
			})
			.returning()
		if (inserted[0]) return { proceed: true, id }

		const [existing] = await this.db
			.select()
			.from(notificationDigest)
			.where(
				and(
					eq(notificationDigest.userId, userId),
					eq(notificationDigest.windowKey, windowKey),
				),
			)
		if (!existing) return { proceed: true, id }
		return { proceed: existing.sentAt == null, id: existing.id }
	}

	/** Send the single-event email for one delivery. */
	private async sendOne(
		def: NotificationTypeDefinition,
		row: Notification,
		input: NotifyInput,
		to: string,
	): Promise<void> {
		const template = def.emailTemplate ?? 'notification'
		const link = isOptOutable(def)
			? this.unsubscribeLink(
					row.userId,
					{ kind: 'type', type: def.key },
					def.key,
				)
			: undefined
		const { subject, html } = renderEmail(
			this.registry,
			template,
			input.emailProps ?? {
				title: row.title,
				body: row.body,
				url: row.url ?? undefined,
				...(this.companyName ? { companyName: this.companyName } : {}),
				...(link ? { unsubscribeUrl: link } : {}),
			},
		)
		await this.mailer.send({ to, subject, html })
	}

	/**
	 * The unsubscribe URL for a message, refusing to produce nothing: an
	 * opt-out-able email without a working unsubscribe is the failure this
	 * feature is least allowed to have, so it fails at the send rather than
	 * shipping a footer-less email.
	 */
	private unsubscribeLink(
		userId: string,
		scope: { kind: 'all' } | { kind: 'type'; type: string },
		typeKey: string,
	): string {
		if (!this.unsubscribeConfig)
			throw new MissingUnsubscribeConfigError(typeKey)
		return unsubscribeUrl(this.unsubscribeConfig, { userId, scope })
	}

	/** Drop rows whose subject the user may no longer read. One check per
	 * distinct subject, so a digest of twenty rows about one project asks once. */
	private async filterVisible(
		userId: string,
		rows: Notification[],
	): Promise<Notification[]> {
		const decisions = new Map<string, boolean>()
		const out: Notification[] = []
		for (const row of rows) {
			if (!row.subjectResource || !row.subjectId) {
				out.push(row)
				continue
			}
			const key = `${row.subjectResource}:${row.subjectId}`
			let allowed = decisions.get(key)
			if (allowed === undefined) {
				allowed = await this.canSee(userId, {
					resource: row.subjectResource,
					id: row.subjectId,
				})
				decisions.set(key, allowed)
			}
			if (allowed) out.push(row)
		}
		return out
	}

	/** Fail closed: a visibility check that throws is a denial, not an allow. */
	private async canSee(
		userId: string,
		subject: NotificationSubject,
	): Promise<boolean> {
		try {
			return (await this.visibility({ userId, subject })) === true
		} catch {
			return false
		}
	}
}
