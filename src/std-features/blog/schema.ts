export const schema = `import { integer, primaryKey, sqliteTable, text } from 'drizzle-orm/sqlite-core'
import { id, timestamps, user } from '../main/schema'

// Category table
export const category = sqliteTable('category', {
	id,
	name: text().notNull().unique(),
})

// Tag table
export const tag = sqliteTable('tag', {
	id,
	name: text().notNull().unique(),
})

// Post table
export const post = sqliteTable('post', {
	id,
	authorId: text()
		.notNull()
		.references(() => user.id, { onDelete: 'cascade' }),
	content: text().notNull(),
	slug: text().notNull().unique(),
	title: text().notNull(),
	publishedAt: integer({ mode: 'timestamp' }),
	...timestamps,
})

// Comment table
export const blogComment = sqliteTable('blog_comment', {
	id,
	content: text().notNull(),
	parentId: text(),
	postId: text()
		.notNull()
		.references(() => post.id, { onDelete: 'cascade' }),
	userId: text()
		.notNull()
		.references(() => user.id, { onDelete: 'cascade' }),
	...timestamps,
})

// Post-Category junction table
export const postCategory = sqliteTable(
	'post_category',
	{
		categoryId: text()
			.notNull()
			.references(() => category.id, { onDelete: 'cascade' }),
		postId: text()
			.notNull()
			.references(() => post.id, { onDelete: 'cascade' }),
	},
	(table) => [primaryKey({ columns: [table.postId, table.categoryId] })],
)

// Post-Tag junction table
export const postTag = sqliteTable(
	'post_tag',
	{
		postId: text()
			.notNull()
			.references(() => post.id, { onDelete: 'cascade' }),
		tagId: text()
			.notNull()
			.references(() => tag.id, { onDelete: 'cascade' }),
	},
	(table) => [primaryKey({ columns: [table.postId, table.tagId] })],
)
`
