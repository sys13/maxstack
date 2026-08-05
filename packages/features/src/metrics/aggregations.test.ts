import { bootPglite } from '@maxstack/core/testing'
import { beforeAll, describe, expect, it } from 'vitest'
import { AUTH_DDL } from '../auth/schema.ts'
import {
	getRecentAuditLogs,
	getSystemMetrics,
	getUserMetrics,
	getUserRegistrationTrends,
	type MetricsDb,
} from './aggregations.ts'

// The audit_log table as `from-spec` would materialize it: quoted camelCase
// columns, uuid PK.
const AUDIT_DDL = `
CREATE TABLE IF NOT EXISTS "audit_log" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "userId" text,
  "action" text,
  "resource" text,
  "createdAt" timestamp
);`

let db: MetricsDb

beforeAll(async () => {
	const client = await bootPglite()
	await client.exec(AUTH_DDL)
	await client.exec(AUDIT_DDL)
	await client.exec(`
    INSERT INTO "user" ("id","name","email","email_verified","role","created_at") VALUES
      ('u1','Ada','ada@x.com', true,  'admin',  now()),
      ('u2','Bo', 'bo@x.com',  false, 'member', now()),
      ('u3','Cy', 'cy@x.com',  false, 'member', now() - interval '40 days');
    INSERT INTO "session" ("id","expires_at","token","user_id","created_at") VALUES
      ('s1', now() + interval '1 day', 't1', 'u1', now()),
      ('s2', now() + interval '1 day', 't2', 'u1', now()),
      ('s3', now() + interval '1 day', 't3', 'u2', now());
    INSERT INTO "audit_log" ("userId","action","resource","createdAt") VALUES
      ('u1','create','organization', now()),
      ('u1','update','organization', now() - interval '1 hour');
  `)
	db = { query: (sql) => client.query(sql) }
})

describe('getUserMetrics', () => {
	it('counts total / recent / verified / admins / active-today', async () => {
		const m = await getUserMetrics(db)
		expect(m.total).toBe(3)
		expect(m.newThisWeek).toBe(2) // u1, u2 (u3 is 40 days old)
		expect(m.newThisMonth).toBe(2)
		expect(m.verified).toBe(1)
		expect(m.admins).toBe(1)
		expect(m.activeToday).toBe(2) // distinct session user-ids: u1, u2
	})
})

describe('getSystemMetrics', () => {
	it('counts audit entries and sessions', async () => {
		const m = await getSystemMetrics(db)
		expect(m.auditLogCount).toBe(2)
		expect(m.sessionCount).toBe(3)
	})
})

describe('getUserRegistrationTrends', () => {
	it('groups registrations by calendar day, ascending', async () => {
		const trends = await getUserRegistrationTrends(db)
		expect(trends).toHaveLength(2) // the 40-days-ago day + today
		expect((trends[0]?.day ?? '') < (trends[1]?.day ?? '')).toBe(true)
		expect(trends[trends.length - 1]?.count).toBe(2) // u1 + u2 today
		expect(trends.every((t) => /^\d{4}-\d{2}-\d{2}$/.test(t.day))).toBe(true)
	})
})

describe('getRecentAuditLogs', () => {
	it('returns entries newest first', async () => {
		const logs = await getRecentAuditLogs(db, 10)
		expect(logs).toHaveLength(2)
		expect(logs[0]?.action).toBe('create') // most recent
	})
})
