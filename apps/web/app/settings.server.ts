/**
 * Owned-code wiring for the account settings page (`routes/settings.tsx`) —
 * task 55, extended by issue #59 with GDPR export/erasure + consent.
 *
 * Bar-2 territory, the same shape as `members.server.ts` / `billing.server.ts`:
 * hand-owned server code that composes better-auth's own mutation endpoints
 * (profile update, password change, session list/revoke, account deletion —
 * all already built by task 50's auth breadth work) plus the new
 * `PreferencesService` (`@maxstack/features/preferences`) into the running app.
 *
 * Profile/password/sessions/delete all go through `auth.api.*` directly against
 * the request's real better-auth session — they are no-ops against the dev
 * fallback identity `resolveUser` hands out when there's no session cookie
 * (`sprout.server.ts`'s `x-maxstack-role` / `dev-admin` default), so the route
 * surfaces "sign in to manage your account" for those fields rather than
 * pretending to succeed. Notification preferences and the org-settings link
 * work under the dev fallback too, since they key off `resolveUser`'s id like
 * every other owned page.
 *
 * Issue #59 gap this closes: `auth.api.deleteUser` (task 55) only ever removed
 * the better-auth `user` row — nothing here previously touched the app data a
 * user actually owns (comments, etc). `eraseAccountData` now runs first in the
 * `deleteAccount` action, so "delete account" really erases the requesting
 * user's own data, not just their login.
 */

import { listUserSessions } from '@maxstack/features/auth'
import {
	CONSENT_DDL,
	ConsentService,
	type ConsentType,
	type ErasureReport,
	eraseUserData,
	exportUserData,
	type GdprExport,
} from '@maxstack/features/compliance'
import { notificationPreferenceDefinitions } from '@maxstack/features/notifications'
import {
	BUILT_IN_PREFERENCES,
	migrateLegacyUserPreferences,
	PREFERENCES_DDL,
	type PreferenceGroupView,
	PreferencesService,
} from '@maxstack/features/preferences'
import { retentionPolicies } from './compliance.server'
import { APP_NOTIFICATION_TYPES } from './notification-types'
import { getAuditSink, getAuth, getSprout, resolveUser } from './sprout.server'

const complianceScope = globalThis as typeof globalThis & {
	__maxstackConsentReady?: boolean
}

export async function getConsentService(): Promise<ConsentService> {
	const { backend } = await getSprout()
	if (!complianceScope.__maxstackConsentReady) {
		await backend.exec(CONSENT_DDL)
		complianceScope.__maxstackConsentReady = true
	}
	return new ConsentService({ db: backend.db })
}

/** The versions currently in force — bump either to re-prompt every user. */
export const TERMS_VERSION = '1'
export const COOKIE_CONSENT_VERSION = '1'

/** Has `userId` already accepted the current version of `type`? Used to gate
 * the cookie banner (don't show it again once accepted) and could gate a
 * forced re-prompt after a version bump. */
export async function hasCurrentConsent(
	userId: string,
	type: ConsentType,
): Promise<boolean> {
	const consent = await getConsentService()
	const version = type === 'terms' ? TERMS_VERSION : COOKIE_CONSENT_VERSION
	return consent.hasAccepted(userId, type, version)
}

/** Record `type` acceptance at the current version for the request's signed-in
 * user. A no-op (not an error) for an anonymous visitor — there's no account
 * to attach consent history to; the cookie banner's local dismissal already
 * covers that case (`cookie-consent-banner.tsx`). */
export async function recordConsent(
	request: Request,
	type: ConsentType,
): Promise<void> {
	const user = await resolveUser(request)
	if (!user) return
	const consent = await getConsentService()
	const version = type === 'terms' ? TERMS_VERSION : COOKIE_CONSENT_VERSION
	await consent.record({ userId: user.id, type, version })
}

const prefsScope = globalThis as typeof globalThis & {
	__maxstackPrefsReady?: boolean
	__maxstackPrefsService?: PreferencesService
}

/**
 * The process-wide preferences service.
 *
 * A singleton, deliberately: its resolve cache is the thing that keeps a
 * settings lookup off every page render, and a per-request
 * instance would start cold every time — turning the cache into decoration.
 *
 * The first call also migrates a pre-#187 `user_preference` table from
 * column-per-preference to key/value in place. It runs before the DDL because
 * the two shapes claim the same table name: `CREATE TABLE IF NOT EXISTS` would
 * otherwise leave an old database on the old shape and fail every read.
 */
export async function getPreferencesService(): Promise<PreferencesService> {
	const { backend } = await getSprout()
	if (!prefsScope.__maxstackPrefsReady) {
		await migrateLegacyUserPreferences((query) => backend.query(query))
		await backend.exec(PREFERENCES_DDL)
		prefsScope.__maxstackPrefsReady = true
	}
	// The declarations are the built-ins plus one pair per declared notification
	// type: an inbox toggle and, for anything opt-out-able, a
	// delivery choice. Derived rather than listed, so a product that adds a
	// notification type gets its opt-out on the settings page for free — and
	// cannot ship a type that has none.
	prefsScope.__maxstackPrefsService ??= new PreferencesService({
		db: backend.db,
		definitions: [
			...BUILT_IN_PREFERENCES,
			...notificationPreferenceDefinitions(APP_NOTIFICATION_TYPES),
		],
	})
	return prefsScope.__maxstackPrefsService
}

export interface SettingsSessionView {
	token: string
	ipAddress: string | null
	userAgent: string | null
	createdAt: string
	current: boolean
}

export interface SettingsView {
	userId: string
	name: string | null
	email: string | null
	/** False for the dev fallback identity — gates password/delete/session UI,
	 * which require a real better-auth session to authorize. */
	hasSession: boolean
	sessions: SettingsSessionView[]
	/**
	 * The *derived* settings form: one field per declaration, with
	 * its resolved value and where that value came from. The page renders these;
	 * it does not know what preferences exist, which is what makes adding one a
	 * declaration rather than a form edit.
	 */
	preferences: PreferenceGroupView[]
	/** The org's defaults, plus whether this viewer may change them. Members see
	 * the same fields read-only, so an inherited value is explicable rather than
	 * mysterious. */
	organizationPreferences: PreferenceGroupView[]
	organizationId: string | null
	/** Has this user accepted the *current* terms version? There's
	 * no client-facing signup form in this app to hook a terms checkbox into
	 * (`createAuth`/`auth.api.signUpEmail` is called by better-auth's own
	 * `/api/auth/*` handler, or the dev seed admin) — the settings page is the
	 * closest natural "first authenticated surface" to prompt on instead. */
	termsAccepted: boolean
	termsVersion: string
}

/** Load everything the settings page renders. Never null: even the dev
 * fallback identity gets a (session-less) view so preferences still work. */
export async function resolveSettings(request: Request): Promise<SettingsView> {
	const user = await resolveUser(request)
	if (!user) throw new Error('Not signed in')

	const auth = await getAuth()
	const current = await auth.api.getSession({ headers: request.headers })
	const hasSession = current?.user != null

	const sessions = hasSession
		? (await listUserSessions(auth, request)).map((s) => ({
				token: s.token,
				ipAddress: s.ipAddress,
				userAgent: s.userAgent,
				createdAt: s.createdAt.toISOString(),
				current: s.current,
			}))
		: []

	const prefs = await getPreferencesService()
	const actor = { id: user.id, role: user.role ?? null }
	const organizationId = user.orgId ?? null
	const [preferences, organizationPreferences, termsAccepted] =
		await Promise.all([
			prefs.describe('user', { userId: user.id, organizationId }, actor),
			organizationId
				? prefs.describe('organization', { organizationId }, actor)
				: Promise.resolve([]),
			hasCurrentConsent(user.id, 'terms'),
		])

	return {
		userId: user.id,
		name: (current?.user.name as string | undefined) ?? null,
		email: (current?.user.email as string | undefined) ?? null,
		hasSession,
		sessions,
		preferences,
		organizationPreferences,
		organizationId,
		termsAccepted,
		termsVersion: TERMS_VERSION,
	}
}

/**
 * Apply a submitted preferences form. The keys are whatever the declarations
 * say, so this reads every field the service knows rather than naming them —
 * the half of "derived UI" that lives on the write side.
 *
 * Authorization is the service's (`setUserPreferences` refuses another user's
 * id; `setOrganizationPreferences` requires owner/admin), so this cannot be the
 * place someone forgets it.
 */
export async function applyPreferencesForm(
	request: Request,
	scope: 'user' | 'organization',
	form: FormData,
): Promise<void> {
	const user = await resolveUser(request)
	if (!user) throw new Error('Not signed in')
	const prefs = await getPreferencesService()
	const actor = { id: user.id, role: user.role ?? null }

	const values: Record<string, unknown> = {}
	for (const definition of prefs.list()) {
		if (!definition.scopes.includes(scope)) continue
		// `getAll` because a boolean field submits its hidden "off" *and* its
		// checkbox when checked; the last value wins, which is the checkbox.
		const submitted = form.getAll(definition.key)
		if (submitted.length === 0) continue
		values[definition.key] = submitted[submitted.length - 1]
	}

	if (scope === 'user') {
		await prefs.setUserPreferences(actor, user.id, values)
		return
	}
	if (!user.orgId) throw new Error('No active organization')
	await prefs.setOrganizationPreferences(actor, user.orgId, values)
}

/**
 * GDPR export: every row the request's user owns across the
 * registry (via the conventional owner columns, `@maxstack/features/compliance`),
 * folded together with the account/session/preference/consent/audit data this
 * module and its siblings already have — a data-subject export the whole app
 * only needs to know its `userId` for, not a bespoke per-feature exporter.
 */
export async function exportAccountData(request: Request): Promise<GdprExport> {
	const user = await resolveUser(request)
	if (!user) throw new Error('Not signed in')

	const { registry, store } = await getSprout()
	const auth = await getAuth()
	const current = await auth.api.getSession({ headers: request.headers })
	const prefs = await getPreferencesService()
	const consent = await getConsentService()

	const [preferences, consentHistory, auditEntries] = await Promise.all([
		// The export carries resolved values (what the account actually behaves
		// like), not just the rows the user happens to have overridden.
		prefs
			.resolve({ userId: user.id, organizationId: user.orgId ?? null })
			.then((resolved) => resolved.toJSON()),
		consent.history(user.id),
		getAuditSink().query({ limit: 500 }),
	])

	return exportUserData(
		{ registry, store, policies: retentionPolicies(registry) },
		user.id,
		{
			account: {
				id: user.id,
				name: (current?.user.name as string | undefined) ?? null,
				email: (current?.user.email as string | undefined) ?? null,
			},
			sessions: current?.session ? [current.session] : [],
			preferences,
			consent: consentHistory,
			// Only this user's own audit trail — never the whole app's.
			auditLog: auditEntries.filter((e) => e.userId === user.id),
		},
	)
}

/**
 * GDPR erasure: hard-deletes every row the request's user owns
 * (the app-data half `deleteUser` never covered — see the module doc) before
 * the `deleteAccount` action removes the auth user row itself. Scoped to the
 * caller's own id by construction (`eraseUserData` refuses a mismatch) — this
 * can never erase another user's data.
 */
export async function eraseAccountData(
	request: Request,
): Promise<ErasureReport> {
	const user = await resolveUser(request)
	if (!user) throw new Error('Not signed in')
	const { registry, store } = await getSprout()
	return eraseUserData(
		{ registry, store, policies: retentionPolicies(registry) },
		user.id,
		user.id,
	)
}
