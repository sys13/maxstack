import { createId } from '@paralleldrive/cuid2'
import { sql } from 'drizzle-orm'
import { integer, sqliteTable, text } from 'drizzle-orm/sqlite-core'

export const id = text()
	.primaryKey()
	.$defaultFn(() => createId())

export const timestamps = {
	createdAt: integer({ mode: 'timestamp' })
		.notNull()
		.default(sql`(unixepoch())`),
	updatedAt: integer({ mode: 'timestamp' })
		.notNull()
		.default(sql`(unixepoch())`),
}

export const user = sqliteTable('user', {
	createdAt: integer({ mode: 'timestamp' })
		.$defaultFn(() => new Date())
		.notNull(),
	email: text().notNull().unique(),
	emailVerified: integer({ mode: 'boolean' })
		.$defaultFn(() => false)
		.notNull(),
	id: text().primaryKey(),
	image: text(),
	name: text().notNull(),
	updatedAt: integer({ mode: 'timestamp' })
		.$defaultFn(() => new Date())
		.notNull(),
})

export const session = sqliteTable('session', {
	createdAt: integer({ mode: 'timestamp' }).notNull(),
	expiresAt: integer({ mode: 'timestamp' }).notNull(),
	id: text().primaryKey(),
	ipAddress: text(),
	token: text().notNull().unique(),
	updatedAt: integer({ mode: 'timestamp' }).notNull(),
	userAgent: text(),
	userId: text()
		.notNull()
		.references(() => user.id, { onDelete: 'cascade' }),
})

export const account = sqliteTable('account', {
	accessToken: text(),
	accessTokenExpiresAt: integer({ mode: 'timestamp' }),
	accountId: text().notNull(),
	createdAt: integer({ mode: 'timestamp' }).notNull(),
	id: text().primaryKey(),
	idToken: text(),
	password: text(),
	providerId: text().notNull(),
	refreshToken: text(),
	refreshTokenExpiresAt: integer({ mode: 'timestamp' }),
	scope: text(),
	updatedAt: integer({ mode: 'timestamp' }).notNull(),
	userId: text()
		.notNull()
		.references(() => user.id, { onDelete: 'cascade' }),
})

export const verification = sqliteTable('verification', {
	createdAt: integer({ mode: 'timestamp' }).$defaultFn(() => new Date()),
	expiresAt: integer({ mode: 'timestamp' }).notNull(),
	id: text().primaryKey(),
	identifier: text().notNull(),
	updatedAt: integer({ mode: 'timestamp' }).$defaultFn(() => new Date()),
	value: text().notNull(),
})
