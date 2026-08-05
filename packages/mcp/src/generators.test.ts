import type { PageSpec } from '@maxstack/spec'
import { suggested } from '@maxstack/spec'
import { describe, expect, it } from 'vitest'
import { pageDescriptor } from './generators.ts'

/**
 * Regression coverage for issue #42: `pageDescriptor` (route generation) and
 * `getRoutes` (`apps/web/app/project-routes.ts`, the live runtime) must derive
 * the exact same slot names from the exact same blocks, or a filled slot
 * silently never renders. `apps/web/app/project-routes.test.ts` pins the
 * runtime side of this contract with an equivalent fixture.
 */
describe('pageDescriptor (issue #42 — agrees with the runtime slot derivation)', () => {
	const page: PageSpec = {
		id: 'pg-subscriptions',
		name: 'Subscriptions',
		route: '/subscriptions',
		entityId: 'e-subscription',
		provenance: suggested(),
		blocks: [
			{ id: 'blk-table', type: 'table', provenance: suggested() },
			{ id: 'blk-renewals', type: 'slot:renewals', provenance: suggested() },
		],
	}

	it('names a slot from its block type suffix, not its block id', () => {
		expect(pageDescriptor(page).slots).toEqual(['renewals'])
	})

	it('drops non-slot blocks entirely — no dead-code stub for `table`/`form`', () => {
		const formOnly: PageSpec = {
			...page,
			blocks: [{ id: 'blk-form', type: 'form', provenance: suggested() }],
		}
		expect(pageDescriptor(formOnly).slots).toEqual([])
	})

	it("agrees with the runtime even when a slot's id doesn't stem-match its type", () => {
		const mismatched: PageSpec = {
			...page,
			blocks: [
				{
					id: 'blk-gear-table',
					type: 'slot:pack_loadout',
					provenance: suggested(),
				},
			],
		}
		expect(pageDescriptor(mismatched).slots).toEqual(['pack_loadout'])
	})
})
