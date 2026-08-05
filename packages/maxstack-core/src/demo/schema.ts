/**
 * Demo schema — the end-to-end proof for Phase 0 (task, author). Exercises the
 * engine's harder paths: `withMeta`, an enum column, an inline FK, defaults,
 * and a timestamp. Property names deliberately match DB column names so the
 * generic demo store can map fields ↔ columns without a naming layer (that
 * layer is future work; see store.ts).
 */

import {
	boolean,
	integer,
	jsonb,
	pgEnum,
	pgTable,
	text,
	timestamp,
	uuid,
} from 'drizzle-orm/pg-core'
import { withMeta } from '../sprout/schema-builder.ts'

export const priorityEnum = pgEnum('priority', ['low', 'medium', 'high'])

/** A tag — the far side of `article.tags`, an array reference (task 38). */
export const tag = pgTable('tag', {
	id: uuid('id').primaryKey().defaultRandom(),
	name: withMeta(text('name'), { label: 'Name', required: true }).notNull(),
})

export const author = pgTable('author', {
	id: uuid('id').primaryKey().defaultRandom(),
	name: withMeta(text('name'), {
		label: 'Name',
		minLength: 1,
		maxLength: 120,
		required: true,
	}).notNull(),
})

export const task = pgTable('task', {
	id: uuid('id').primaryKey().defaultRandom(),
	title: withMeta(text('title'), {
		label: 'Title',
		placeholder: 'What needs doing?',
		minLength: 1,
		maxLength: 200,
		required: true,
	}).notNull(),
	done: withMeta(boolean('done'), { label: 'Done' }).notNull().default(false),
	priority: withMeta(priorityEnum('priority'), { label: 'Priority' })
		.notNull()
		.default('medium'),
	authorId: withMeta(uuid('authorId'), { label: 'Author' }).references(
		() => author.id,
		{ onDelete: 'cascade' },
	),
	createdAt: timestamp('createdAt').notNull().defaultNow(),
})

/**
 * `article` exercises the rich-input library (Plan v5 task 39): a markdown body,
 * an image upload, and a password — each column carries only the metadata that
 * *inference* reads (`markdown` / `isFile` / `format`), so the form renders the
 * matching editor with zero per-field config, and `<Field>` renders the matching
 * display. Also a rating and a brand color to exercise the specialty widgets.
 */
export const article = pgTable('article', {
	id: uuid('id').primaryKey().defaultRandom(),
	title: withMeta(text('title'), {
		label: 'Title',
		minLength: 1,
		required: true,
	}).notNull(),
	body: withMeta(text('body'), { label: 'Body', markdown: true }),
	coverImage: withMeta(text('coverImage'), {
		label: 'Cover image',
		isFile: true,
		fileAccept: 'image/*',
	}),
	password: withMeta(text('password'), { label: 'Password' }),
	rating: withMeta(integer('rating'), {
		label: 'Rating',
		format: 'rating',
		max: 5,
	}),
	brandColor: withMeta(text('brandColor'), {
		label: 'Brand color',
		format: 'color',
	}),
	// The "many" side of a reference (task 38): an array of `tag` ids, resolved
	// and rendered as chips by `<ReferenceArrayField>`, edited as a multi-select.
	tags: withMeta(jsonb('tags'), {
		label: 'Tags',
		arrayReference: { table: 'tag', column: 'id', displayField: 'name' },
	}),
})

/**
 * `comment` is the child side of a reverse reference to `article` — it exists so
 * the demo can show a *count* of an article's comments without loading them
 * (`<ReferenceManyCount>`, task 38): `store.count('comment', { filter: {
 * articleId } })`.
 *
 * It also demos soft delete (`ResourceConfig.softDelete`):
 * `deletedAt` is nullable, `null` while the comment is live. Moderation
 * "delete" for a comment is exactly the recoverable-within-a-window case the
 * exit criterion asks for — a hard `DELETE` would make a bad moderation call
 * unrecoverable.
 */
export const comment = pgTable('comment', {
	id: uuid('id').primaryKey().defaultRandom(),
	articleId: withMeta(uuid('articleId'), { label: 'Article' }).references(
		() => article.id,
		{ onDelete: 'cascade' },
	),
	body: withMeta(text('body'), { label: 'Body' }).notNull(),
	deletedAt: timestamp('deletedAt'),
})

/** DDL to materialize the demo schema in a fresh pglite database. */
export const DEMO_DDL = `
CREATE TYPE priority AS ENUM ('low', 'medium', 'high');
CREATE TABLE author (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name text NOT NULL
);
CREATE TABLE tag (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name text NOT NULL
);
CREATE TABLE task (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  title text NOT NULL,
  done boolean NOT NULL DEFAULT false,
  priority priority NOT NULL DEFAULT 'medium',
  "authorId" uuid REFERENCES author(id) ON DELETE CASCADE,
  "createdAt" timestamp NOT NULL DEFAULT now()
);
CREATE TABLE article (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  title text NOT NULL,
  body text,
  "coverImage" text,
  password text,
  rating integer,
  "brandColor" text,
  tags jsonb
);
CREATE TABLE comment (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "articleId" uuid REFERENCES article(id) ON DELETE CASCADE,
  body text NOT NULL,
  "deletedAt" timestamp
);
`
