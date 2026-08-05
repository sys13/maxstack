/**
 * The upgrade path, which is the half of this schema no fresh-database test can
 * see. Found live: running the DDL against a dogfood project that
 * already had a pre-#184 `notification` table failed on `column "dedupe_key"
 * does not exist` — `CREATE TABLE IF NOT EXISTS` had left the old shape in place
 * and the unique index went in on top of it. Every test here would have been
 * green before that fix except the first one.
 */

import type { PGlite } from '@electric-sql/pglite'
import { bootPglite } from '@maxstack/core/testing'
import { drizzle } from 'drizzle-orm/pglite'
import { describe, expect, it } from 'vitest'
import { createMemoryMailer } from '../email/mailer.ts'
import { EmailRegistry } from '../email/registry.ts'
import { BUILT_IN_PREFERENCES } from '../preferences/definitions.ts'
import { PREFERENCES_DDL } from '../preferences/schema.ts'
import { PreferencesService } from '../preferences/service.ts'
import { NOTIFICATIONS_DDL, NOTIFICATIONS_DDL_PRE_184 } from './schema.ts'
import { NotificationService } from './service.ts'
import { notificationPreferenceDefinitions } from './types.ts'

async function columns(client: PGlite): Promise<string[]> {
	const { rows } = await client.query<{ column_name: string }>(
		`SELECT column_name FROM information_schema.columns WHERE table_name = 'notification'`,
	)
	return rows.map((r) => r.column_name).sort()
}

function serviceOver(client: PGlite): NotificationService {
	const db = drizzle({ client })
	return new NotificationService({
		db,
		mailer: createMemoryMailer(),
		registry: new EmailRegistry(),
		preferences: new PreferencesService({
			db,
			definitions: [
				...BUILT_IN_PREFERENCES,
				...notificationPreferenceDefinitions(),
			],
		}),
		unsubscribe: { secret: 's', baseUrl: 'https://app.example/unsubscribe' },
	})
}

describe('NOTIFICATIONS_DDL', () => {
	it('upgrades a pre-#184 table in place instead of failing on it', async () => {
		const client = await bootPglite()
		await client.exec(NOTIFICATIONS_DDL_PRE_184)
		await client.exec(PREFERENCES_DDL)
		await client.exec(`INSERT INTO notification (id, user_id, type, title, body, category)
      VALUES ('old-1', 'u1', 'invitation-accepted', 'Old row', 'From before', 'transactional')`)

		await client.exec(NOTIFICATIONS_DDL)

		expect(await columns(client)).toContain('dedupe_key')
		const { rows } = await client.query<{
			dedupe_key: string
			category: string
			in_app: boolean
		}>(
			`SELECT dedupe_key, category, in_app FROM notification WHERE id = 'old-1'`,
		)
		// The old row keeps its content, gains a dedupe key it cannot collide on,
		// and its legacy category is translated rather than left unreadable.
		expect(rows[0]).toMatchObject({
			dedupe_key: 'old-1',
			category: 'immediate',
			in_app: true,
		})
	})

	it('leaves the upgraded table able to suppress a duplicate', async () => {
		const client = await bootPglite()
		await client.exec(NOTIFICATIONS_DDL_PRE_184)
		await client.exec(PREFERENCES_DDL)
		await client.exec(NOTIFICATIONS_DDL)

		const service = serviceOver(client)
		const event = {
			userId: 'u1',
			type: 'security-alert' as const,
			title: 'New sign-in',
			body: 'A new device signed in.',
			email: 'u1@example.com',
			dedupeKey: 'k',
		}
		await service.notify(event)
		const second = await service.notify(event)
		expect(second.duplicate).toBe(true)
		expect(await service.listNotifications('u1')).toHaveLength(1)
	})

	it('is safe to run twice on a fresh database', async () => {
		const client = await bootPglite()
		await client.exec(NOTIFICATIONS_DDL)
		await client.exec(NOTIFICATIONS_DDL)
		expect(await columns(client)).toEqual([
			'body',
			'category',
			'created_at',
			'dedupe_key',
			'emailed',
			'id',
			'in_app',
			'read',
			'subject_id',
			'subject_resource',
			'title',
			'type',
			'url',
			'user_id',
		])
	})
})
