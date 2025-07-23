import { drizzle } from 'drizzle-orm/libsql'
import * as schema from '../../database/_schema'
import { relations } from '../../database/relations'

export const db = drizzle({
	schema,
	relations,
	// biome-ignore lint/style/noNonNullAssertion: has a default value
	connection: { url: process.env.DB_FILE_NAME! },
	casing: 'snake_case',
})
