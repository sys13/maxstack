import type { PGlite } from '@electric-sql/pglite'
import { bootPglite } from '@maxstack/core/testing'
import { drizzle } from 'drizzle-orm/pglite'
import { beforeEach, describe, expect, it } from 'vitest'
import { usePglite } from '../testing/pglite-fixture.ts'
import type { PreferenceDefinition } from './definitions.ts'
import { definitionErrors } from './definitions.ts'
import { migrateLegacyUserPreferences, PREFERENCES_DDL } from './schema.ts'
import {
	canManageOrgPreferences,
	PreferencePermissionError,
	PreferencesService,
	UnknownPreferenceError,
} from './service.ts'

type Db = ReturnType<typeof drizzle>

let client: PGlite
let db: Db
let service: PreferencesService

const alice = { id: 'u1', role: 'member' }
const admin = { id: 'u2', role: 'admin' }

/** A registry exercising every declared type and both scopes. */
const DEFINITIONS: PreferenceDefinition[] = [
	{
		key: 'email-notifications',
		label: 'Email notifications',
		type: 'boolean',
		scopes: ['user', 'organization'],
		default: true,
		group: 'Notifications',
	},
	{
		key: 'digest-frequency',
		label: 'Digest frequency',
		type: 'enum',
		scopes: ['user', 'organization'],
		default: 'weekly',
		options: [
			{ label: 'Daily', value: 'daily' },
			{ label: 'Weekly', value: 'weekly' },
		],
		group: 'Notifications',
	},
	{
		key: 'session-timeout-minutes',
		label: 'Session timeout',
		type: 'number',
		scopes: ['organization'],
		default: 60,
		group: 'Security',
	},
]

const pg = usePglite(PREFERENCES_DDL)

beforeEach(() => {
	client = pg.client
	db = pg.db
	service = new PreferencesService({ db, definitions: DEFINITIONS })
})

describe('resolution order', () => {
	it('is the declared default when nothing is stored', async () => {
		const prefs = await service.resolve({ userId: 'u1', organizationId: 'o1' })
		expect(prefs.bool('email-notifications')).toBe(true)
		expect(prefs.string('digest-frequency')).toBe('weekly')
		expect(prefs.number('session-timeout-minutes')).toBe(60)
		expect(prefs.source('email-notifications')).toBe('default')
	})

	it('prefers the organization value over the declared default', async () => {
		await service.setOrganizationPreferences(admin, 'o1', {
			'email-notifications': false,
		})
		const prefs = await service.resolve({ userId: 'u1', organizationId: 'o1' })
		expect(prefs.bool('email-notifications')).toBe(false)
		expect(prefs.source('email-notifications')).toBe('organization')
	})

	it('prefers the user’s own value over the organization’s', async () => {
		await service.setOrganizationPreferences(admin, 'o1', {
			'email-notifications': false,
		})
		await service.setUserPreferences(alice, 'u1', {
			'email-notifications': true,
		})
		const prefs = await service.resolve({ userId: 'u1', organizationId: 'o1' })
		expect(prefs.bool('email-notifications')).toBe(true)
		expect(prefs.source('email-notifications')).toBe('user')
	})

	it('distinguishes "chose false" from "has not chosen" — the point of the shape', async () => {
		await service.setOrganizationPreferences(admin, 'o1', {
			'email-notifications': true,
		})
		await service.setUserPreferences(alice, 'u1', {
			'email-notifications': false,
		})
		expect(
			(await service.resolve({ userId: 'u1', organizationId: 'o1' })).bool(
				'email-notifications',
			),
		).toBe(false)

		// Clearing returns the user to the org default rather than to `false`.
		await service.clearUserPreference(alice, 'u1', 'email-notifications')
		const cleared = await service.resolve({
			userId: 'u1',
			organizationId: 'o1',
		})
		expect(cleared.bool('email-notifications')).toBe(true)
		expect(cleared.source('email-notifications')).toBe('organization')
	})

	it('never inherits an org value for a user-only preference', async () => {
		const userOnly = new PreferencesService({
			db,
			definitions: [
				{
					key: 'product-updates',
					label: 'Product updates',
					type: 'boolean',
					scopes: ['user'],
					default: true,
				},
			],
		})
		await expect(
			userOnly.setOrganizationPreferences(admin, 'o1', {
				'product-updates': false,
			}),
		).rejects.toThrow(/cannot be set at the organization level/)
	})
})

describe('read cost', () => {
	it('is one query per scope, and none inside the cache window', async () => {
		await service.resolve({ userId: 'u1', organizationId: 'o1' })
		expect(service.queryCount()).toBe(2)
		// The trap #187 names: a settings lookup on every page. Ten more resolves
		// inside the TTL cost nothing.
		for (let i = 0; i < 10; i++)
			await service.resolve({ userId: 'u1', organizationId: 'o1' })
		expect(service.queryCount()).toBe(2)
	})

	it('re-reads after the TTL elapses', async () => {
		let clock = new Date('2026-01-01T00:00:00Z')
		const ttl = new PreferencesService({
			db,
			definitions: DEFINITIONS,
			cacheTtlMs: 30_000,
			now: () => clock,
		})
		await ttl.resolve({ userId: 'u1' })
		await ttl.resolve({ userId: 'u1' })
		expect(ttl.queryCount()).toBe(1)
		clock = new Date('2026-01-01T00:01:00Z')
		await ttl.resolve({ userId: 'u1' })
		expect(ttl.queryCount()).toBe(2)
	})

	it('shows a write immediately — the cache is invalidated, not waited out', async () => {
		await service.resolve({ userId: 'u1' })
		await service.setUserPreferences(alice, 'u1', {
			'email-notifications': false,
		})
		expect(
			(await service.resolve({ userId: 'u1' })).bool('email-notifications'),
		).toBe(false)
	})

	it('caches the two scopes separately, so an org change does not flush every member', async () => {
		await service.resolve({ userId: 'u1', organizationId: 'o1' })
		await service.setOrganizationPreferences(admin, 'o1', {
			'email-notifications': false,
		})
		// The org scope was re-read (2 → 3 for the resolve inside the write, then
		// the read below); the user scope stayed cached.
		const before = service.queryCount()
		await service.resolve({ userId: 'u1' })
		expect(service.queryCount()).toBe(before)
	})
})

describe('typing', () => {
	it('refuses an unknown key rather than storing it', async () => {
		await expect(
			service.setUserPreferences(alice, 'u1', { 'not-a-preference': true }),
		).rejects.toThrow(UnknownPreferenceError)
	})

	it('refuses a value of the wrong type', async () => {
		await expect(
			service.setUserPreferences(alice, 'u1', { 'digest-frequency': 'hourly' }),
		).rejects.toThrow(/expects a enum/)
		await expect(
			service.setOrganizationPreferences(admin, 'o1', {
				'session-timeout-minutes': 'soon',
			}),
		).rejects.toThrow(/expects a number/)
	})

	it('coerces form values — an unchecked box is false, not absent', async () => {
		await service.setUserPreferences(alice, 'u1', {
			'email-notifications': 'on',
		})
		expect(
			(await service.resolve({ userId: 'u1' })).bool('email-notifications'),
		).toBe(true)
		await service.setUserPreferences(alice, 'u1', {
			'email-notifications': undefined,
		})
		expect(
			(await service.resolve({ userId: 'u1' })).bool('email-notifications'),
		).toBe(false)
	})

	it('round-trips a stored false as a boolean, not the string "false"', async () => {
		await service.setUserPreferences(alice, 'u1', {
			'email-notifications': false,
		})
		expect(
			(await service.resolve({ userId: 'u1' })).get('email-notifications'),
		).toBe(false)
	})

	it('rejects a malformed registry at construction', () => {
		expect(
			() =>
				new PreferencesService({
					db,
					definitions: [
						{
							key: 'bad',
							label: 'Bad',
							type: 'enum',
							scopes: ['user'],
							default: 'x',
						},
					],
				}),
		).toThrow(/needs options/)
		expect(
			definitionErrors([
				{
					key: 'n',
					label: 'N',
					type: 'number',
					scopes: [],
					default: 'not a number',
				},
			]),
		).toEqual([
			'preference "n": names no scope — it could never be set',
			'preference "n": default "not a number" is not a number',
		])
	})
})

describe('authorization', () => {
	it('lets a user change only their own preferences', async () => {
		await expect(
			service.setUserPreferences(alice, 'someone-else', {
				'email-notifications': false,
			}),
		).rejects.toThrow(PreferencePermissionError)
		// Not even an admin: the org default is the supported way to steer members.
		await expect(
			service.setUserPreferences(admin, 'u1', { 'email-notifications': false }),
		).rejects.toThrow(PreferencePermissionError)
	})

	it('requires an owner or admin for organization defaults, and is fail-closed', async () => {
		expect(canManageOrgPreferences({ id: 'u1', role: 'owner' })).toBe(true)
		expect(canManageOrgPreferences({ id: 'u1', role: 'member' })).toBe(false)
		expect(canManageOrgPreferences(null)).toBe(false)
		await expect(
			service.setOrganizationPreferences(alice, 'o1', {
				'email-notifications': false,
			}),
		).rejects.toThrow(/requires an owner or admin/)
		await expect(
			service.setOrganizationPreferences(null, 'o1', {
				'email-notifications': false,
			}),
		).rejects.toThrow(PreferencePermissionError)
	})
})

describe('the derived settings UI', () => {
	it('renders one field per declaration, grouped, with its source', async () => {
		await service.setOrganizationPreferences(admin, 'o1', {
			'email-notifications': false,
		})
		const groups = await service.describe(
			'user',
			{ userId: 'u1', organizationId: 'o1' },
			alice,
		)
		expect(groups.map((g) => g.group)).toEqual(['Notifications'])
		expect(groups[0]?.fields.map((f) => f.key)).toEqual([
			'email-notifications',
			'digest-frequency',
		])
		expect(groups[0]?.fields[0]).toMatchObject({
			label: 'Email notifications',
			type: 'boolean',
			value: false,
			source: 'organization',
			editable: true,
		})
		// The enum carries its options, so the form renders a select without
		// knowing what a digest frequency is.
		expect(groups[0]?.fields[1]?.options).toHaveLength(2)
	})

	it('omits fields the scope cannot set, and marks the org form read-only for a member', async () => {
		const orgGroups = await service.describe(
			'organization',
			{ organizationId: 'o1' },
			alice,
		)
		expect(orgGroups.flatMap((g) => g.fields).map((f) => f.key)).toEqual([
			'email-notifications',
			'digest-frequency',
			'session-timeout-minutes',
		])
		expect(orgGroups.every((g) => g.fields.every((f) => !f.editable))).toBe(
			true,
		)

		const asAdmin = await service.describe(
			'organization',
			{ organizationId: 'o1' },
			admin,
		)
		expect(asAdmin.every((g) => g.fields.every((f) => f.editable))).toBe(true)

		// `session-timeout-minutes` is org-only, so a user form never shows it.
		const userGroups = await service.describe('user', { userId: 'u1' }, alice)
		expect(userGroups.flatMap((g) => g.fields).map((f) => f.key)).not.toContain(
			'session-timeout-minutes',
		)
	})
})

describe('migrating the pre-#187 column-per-preference table', () => {
	it('copies each column into a key/value row and drops the old table', async () => {
		const legacy = await bootPglite()
		await legacy.exec(`
			CREATE TABLE user_preference (
			  user_id text PRIMARY KEY,
			  email_notifications boolean NOT NULL DEFAULT true,
			  in_app_notifications boolean NOT NULL DEFAULT true,
			  product_updates boolean NOT NULL DEFAULT true,
			  updated_at timestamp NOT NULL DEFAULT now()
			);
			INSERT INTO user_preference (user_id, email_notifications, in_app_notifications, product_updates)
			VALUES ('u1', false, true, false);
		`)
		const run = (q: string) => legacy.query(q)
		const { copiedKeys } = await migrateLegacyUserPreferences(run)
		expect(copiedKeys).toEqual([
			'email-notifications',
			'in-app-notifications',
			'product-updates',
		])

		const migrated = new PreferencesService({ db: drizzle({ client: legacy }) })
		const prefs = await migrated.resolve({ userId: 'u1' })
		expect(prefs.bool('email-notifications')).toBe(false)
		expect(prefs.bool('in-app-notifications')).toBe(true)
		expect(prefs.bool('product-updates')).toBe(false)
		// The choice survived as a choice, not as a default.
		expect(prefs.source('email-notifications')).toBe('user')
	})

	it('is a no-op on a table already in the new shape, and safe to re-run', async () => {
		const run = (q: string) => client.query(q)
		expect(await migrateLegacyUserPreferences(run)).toEqual({ copiedKeys: [] })
		await service.setUserPreferences(alice, 'u1', {
			'email-notifications': false,
		})
		expect(await migrateLegacyUserPreferences(run)).toEqual({ copiedKeys: [] })
		service.invalidate()
		expect(
			(await service.resolve({ userId: 'u1' })).bool('email-notifications'),
		).toBe(false)
	})
})
