/**
 * The two gates on create-inline in the FK picker (#443).
 *
 * The picker's behaviour once it has a plan is tested in `@maxstack/ui`. What
 * can only be tested here is the *decision* — because both halves of it are
 * facts about a resource the form is not for, and a wrong answer either way is a
 * defect with a name:
 *
 *  - too permissive, and the "Create …" row appears for a viewer whose click
 *    403s, or mints a half-record that 422s. An affordance that promises and
 *    then refuses is the #388 shape.
 *  - too restrictive, and a capability silently withdraws itself with nowhere to
 *    look — which is the state #443 found the whole feature in.
 *
 * The `requiredCreateFields` case gets the most attention because it is the one
 * that drifts: it is a derivation from the create schema, and the schema is
 * edited by people who have never heard of this file.
 */

import type { SproutUser } from '@maxstack/core'
import { ResourceRegistry } from '@maxstack/core'
import { article, author, comment, tag, task } from '@maxstack/core/demo'
import { integer, pgTable, text, uuid } from 'drizzle-orm/pg-core'
import { beforeAll, describe, expect, it } from 'vitest'
import {
	getSprout,
	referenceCreatePlan,
	referenceFieldOptions,
} from './sprout.server'

const signedIn: SproutUser = { id: 'u1', role: 'user' }

/** A registry with one resource in it, so a gate can be asked in isolation. */
function registryOf(
	table: Parameters<ResourceRegistry['register']>[0],
	config: Parameters<ResourceRegistry['register']>[1] = {},
) {
	const registry = new ResourceRegistry()
	registry.register(table, config)
	return registry
}

const ask = (
	registry: ResourceRegistry,
	table: string,
	display: string | undefined,
	user: SproutUser | null = signedIn,
) =>
	referenceCreatePlan(
		{ registry, user } as Parameters<typeof referenceCreatePlan>[0],
		table,
		'id',
		display,
	)

describe('gate 1 — may this viewer create one', () => {
	it('offers create to a viewer the target admits', async () => {
		const registry = registryOf(author, {
			titleField: 'name',
			access: { read: 'public', create: 'authenticated' },
		})
		expect(await ask(registry, 'author', 'name')).toEqual({
			resource: 'author',
			idField: 'id',
			labelField: 'name',
		})
	})

	it('withholds it from a viewer who may read the target but not write it', async () => {
		// The permission the issue turns on. Reading a customer list to pick from
		// and creating a customer are different grants, and the parent form's
		// permission is not the one that counts.
		const registry = registryOf(author, {
			titleField: 'name',
			access: { read: 'public', create: 'authenticated' },
		})
		expect(await ask(registry, 'author', 'name', null)).toBeUndefined()
	})

	it('withholds it from an api-key identity outside its scope', async () => {
		// Not a rule of this module — `canPerformAction` runs the api-key scope gate
		// before the resource's own rule, closed by default. Pinned here because the
		// affordance must inherit every narrowing the write does, not just the one
		// this file happens to know the name of.
		const registry = registryOf(author, {
			titleField: 'name',
			access: { read: 'public', create: 'public' },
		})
		const keyed: SproutUser = {
			id: 'k1',
			role: 'user',
			apiKeyScope: { author: ['read'] },
		}
		expect(await ask(registry, 'author', 'name', keyed)).toBeUndefined()
	})

	it('offers nothing for a resource the registry does not have', async () => {
		expect(await ask(new ResourceRegistry(), 'ghost', 'name')).toBeUndefined()
	})
})

describe('gate 2 — is a name enough to make one', () => {
	it('offers create when the label is the only thing required', async () => {
		// `tag` is the shape the affordance exists for: one required field, and the
		// typed string is it.
		const registry = registryOf(tag, { titleField: 'name' })
		expect(await ask(registry, 'tag', 'name')).toBeDefined()
	})

	it('offers it when everything else defaults or is nullable', async () => {
		// `task` requires only `title`; `done` and `priority` default, `authorId` is
		// nullable, `createdAt` is a defaulted timestamp the schema drops. A rule
		// that counted columns rather than reading the create schema would refuse
		// this one, and refuse most real entities with it.
		const registry = registryOf(task, { titleField: 'title' })
		expect(await ask(registry, 'task', 'title')).toBeDefined()
	})

	it('withholds it when the target requires a second field', async () => {
		// Minting from a single string here writes a half-record or 422s. Neither is
		// something to put behind a one-click affordance, so the row is absent.
		const invoice = pgTable('invoice', {
			id: uuid('id').primaryKey().defaultRandom(),
			label: text('label').notNull(),
			amountCents: integer('amountCents').notNull(),
		})
		const registry = registryOf(invoice, { titleField: 'label' })
		expect(await ask(registry, 'invoice', 'label')).toBeUndefined()
	})

	it('does not count the columns opCreate stamps after the caller', async () => {
		// The tenant column is required of the *row* and never of the caller —
		// `opCreate` overwrites whatever a client sent with the active org. Counting
		// it as outstanding would withdraw create-inline from every org-scoped
		// resource in the product, which is nearly all of them.
		const note = pgTable('note', {
			id: uuid('id').primaryKey().defaultRandom(),
			title: text('title').notNull(),
			orgId: text('orgId').notNull(),
		})
		const registry = registryOf(note, {
			titleField: 'title',
			tenantField: 'orgId',
		})
		expect(await ask(registry, 'note', 'title')).toBeDefined()
	})

	it('offers nothing when there is no field a name could become', async () => {
		// No title field: the typed string has nowhere to go, so "create from what
		// you typed" is not a coherent offer.
		const registry = registryOf(article, { titleField: 'title' })
		expect(await ask(registry, 'article', undefined)).toBeUndefined()
	})
})

describe('referenceFieldOptions carries the decision to the right column', () => {
	it('plans create for the FK columns that qualify, beside their options', async () => {
		const { registry, store } = await getSprout()
		const plans = await referenceFieldOptions(
			{ registry, store, user: signedIn } as never,
			registry.get('task')?.resource as never,
		)
		// `task.authorId` points at `author`, which a signed-in viewer may create
		// and which needs only its name.
		expect(plans.create.authorId).toEqual({
			resource: 'author',
			idField: 'id',
			labelField: 'name',
		})
		// And the options half is untouched by any of this.
		expect(plans.options.authorId).toBeDefined()
	})

	it('plans nothing for an anonymous viewer, while still listing the options', async () => {
		// The asymmetry is the point: `author` reads `public` and creates
		// `authenticated`, so an anonymous form can pick an author and is not
		// offered the chance to invent one.
		const { registry, store } = await getSprout()
		const plans = await referenceFieldOptions(
			{ registry, store, user: null } as never,
			registry.get('task')?.resource as never,
		)
		expect(plans.create.authorId).toBeUndefined()
		expect(plans.options.authorId).toBeDefined()
	})

	it('plans create for the many side too', async () => {
		// `article.tags` is an array reference; both sides pick from the same
		// records, so both sides create into the same resource.
		const { registry, store } = await getSprout()
		const plans = await referenceFieldOptions(
			{ registry, store, user: signedIn } as never,
			registry.get('article')?.resource as never,
		)
		expect(plans.create.tags?.resource).toBe('tag')
	})
})

describe('a soft-deleting target', () => {
	it('is not disqualified by its own deletedAt column', async () => {
		// Server-stamped `null` on create, exactly like the tenant column.
		const registry = registryOf(comment, {
			titleField: 'body',
			softDelete: true,
		})
		expect(await ask(registry, 'comment', 'body')).toBeDefined()
	})
})

beforeAll(async () => {
	// The integration block reads the app's own registry + store; touching it once
	// up front keeps the first assertion from paying the boot.
	await getSprout()
})
