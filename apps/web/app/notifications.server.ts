/**
 * Owned-code wiring for the notifications inbox (`routes/notifications.tsx`) —
 * task 56, rebuilt for issue #184.
 *
 * Bar-2 territory, the same shape as `members.server.ts` / `settings.server.ts`:
 * hand-owned server code that composes `NotificationService`
 * (`@maxstack/features/notifications`) into the running app. The feature owns
 * the model (declared types, per-type preferences, idempotent delivery, digests);
 * this module supplies the four things only the app can know — a database, a
 * mailer, *who may read which row*, and where the unsubscribe link points.
 *
 * The visibility check is the interesting one. The feature refuses to render
 * content about a row the recipient cannot read, but it cannot answer that
 * question itself; this module answers it from the project's own access rules,
 * so a notification about a project someone lost access to stops showing its
 * title — in the inbox and inside the digest.
 *
 * No real mail transport is configured (this is a demo app), so the mailer is
 * an in-memory recorder kept on `globalThis` — the same "demo mode" posture
 * `billing.server.ts`'s memory billing provider uses — so sent mail is
 * inspectable on the page instead of vanishing into a console log.
 */

import { user as authUser } from '@maxstack/features/auth'
import {
	createMemoryMailer,
	emailRegistry,
	type Mailer,
} from '@maxstack/features/email'
import {
	NOTIFICATIONS_DDL,
	type Notification,
	NotificationService,
} from '@maxstack/features/notifications'
import { eq } from 'drizzle-orm'
import { APP_NOTIFICATION_TYPES } from './notification-types'
import { getPreferencesService } from './settings.server'
import { getSprout, resolveUser } from './sprout.server'

type Db = Awaited<ReturnType<typeof getSprout>>['backend']['db']

const notificationsScope = globalThis as typeof globalThis & {
	__maxstackNotificationsReady?: boolean
	__maxstackMailer?: ReturnType<typeof createMemoryMailer>
}

function demoMailer(): Mailer & { sent: unknown[] } {
	notificationsScope.__maxstackMailer ??= createMemoryMailer()
	return notificationsScope.__maxstackMailer
}

/**
 * Where unsubscribe links point, and what signs them.
 *
 * The secret falls back to a fixed dev string so the demo works out of the box;
 * in a deployed app it is an env var, because a predictable secret means anyone
 * can mint a link that unsubscribes anyone. That is the *only* thing a forged
 * token can do — see the module doc in `notifications/unsubscribe.ts` — but it
 * is still not a thing to leave open.
 */
function unsubscribeConfig() {
	const base = process.env.APP_URL ?? 'http://localhost:5173'
	return {
		secret:
			process.env.NOTIFICATIONS_UNSUBSCRIBE_SECRET ??
			'dev-unsubscribe-secret-not-for-production',
		baseUrl: `${base.replace(/\/$/, '')}/unsubscribe`,
	}
}

/**
 * May `userId` read `subject`? Answered from the project's own registry: a
 * resource with an owner column is visible to its owner (and to an admin);
 * anything else in the registry is visible to any signed-in user, which is what
 * this demo app's access rules already say.
 *
 * Fails closed by construction — an unknown resource returns false, and the
 * feature treats a thrown check as a denial.
 */
async function canRead(opts: {
	userId: string
	subject: { resource: string; id: string }
}): Promise<boolean> {
	const { registry, store } = await getSprout()
	const resource = registry.get(opts.subject.resource)
	if (!resource) return false
	const row = (await store.get(opts.subject.resource, opts.subject.id)) as
		| Record<string, unknown>
		| undefined
	if (!row) return false
	// The conventional owner columns, same as the compliance bundle's.
	for (const column of ['userId', 'ownerId', 'createdBy', 'authorId']) {
		const owner = row[column]
		if (typeof owner === 'string' && owner) return owner === opts.userId
	}
	return true
}

export async function getNotificationService(): Promise<NotificationService> {
	const { backend } = await getSprout()
	if (!notificationsScope.__maxstackNotificationsReady) {
		// Idempotent, and it upgrades a pre-#184 table in place — a project
		// created before this issue already has a `notification` table that
		// `CREATE TABLE IF NOT EXISTS` would otherwise leave in its old shape.
		await backend.exec(NOTIFICATIONS_DDL)
		notificationsScope.__maxstackNotificationsReady = true
	}
	return new NotificationService({
		db: backend.db,
		mailer: demoMailer(),
		registry: emailRegistry,
		preferences: await getPreferencesService(),
		types: APP_NOTIFICATION_TYPES,
		visibility: canRead,
		unsubscribe: unsubscribeConfig(),
	})
}

/** An address for `userId` — the auth `user` table when a row exists, else a
 * deterministic placeholder (dev-fallback/invite-derived ids have no auth row). */
export async function resolveEmail(db: Db, userId: string): Promise<string> {
	const [row] = await db.select().from(authUser).where(eq(authUser.id, userId))
	return (
		(row as { email?: string } | undefined)?.email ??
		`${userId}@example.invalid`
	)
}

export interface NotificationsView {
	userId: string
	email: string
	items: Notification[]
	unreadCount: number
	sentEmails: { to: string; subject: string }[]
	/** What each declared type would do for this viewer right now — the answer
	 * to "why didn't I get that email", rendered instead of guessed at. */
	delivery: {
		key: string
		label: string
		class: string
		email: string
		inApp: boolean
	}[]
}

export async function resolveNotifications(
	request: Request,
): Promise<NotificationsView | null> {
	const user = await resolveUser(request)
	if (!user) return null
	const { backend } = await getSprout()
	const service = await getNotificationService()
	const [items, unreadCount, email] = await Promise.all([
		service.listNotifications(user.id),
		service.unreadCount(user.id),
		resolveEmail(backend.db, user.id),
	])
	const delivery = await Promise.all(
		service.listTypes().map(async (type) => ({
			key: type.key,
			label: type.label,
			class: type.class,
			...(await service.deliveryFor(user.id, type.key, user.orgId ?? null)),
		})),
	)
	const mailer = demoMailer()
	return {
		userId: user.id,
		email,
		items,
		unreadCount,
		sentEmails: (mailer.sent as { to: string; subject: string }[]).filter(
			(m) => m.to === email,
		),
		delivery,
	}
}
