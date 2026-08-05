/**
 * The onboarding wizard's server wiring, driven over the demo
 * backend the web app actually boots (same approach as `auth.server.test.ts`):
 * fresh-install detection, workspace creation, invites, and the demo-data
 * load path.
 */

import { describe, expect, it } from 'vitest'
import {
	createWorkspace,
	inviteTeammate,
	loadDemoData,
	resolveOnboarding,
} from './onboarding.server'
import { hasDemoData, isFreshProject } from './sprout.server'

const req = () => new Request('http://localhost/onboarding')

describe('onboarding', () => {
	it('resolves state for the dev-fallback user, with no workspace yet', async () => {
		const state = await resolveOnboarding(req())
		expect(state).not.toBeNull()
		expect(state?.user.id).toBe('dev-admin')
		expect(state?.needsWorkspace).toBe(true)
		expect(state?.orgs).toEqual([])
	})

	it('creates a workspace and adds the creator as owner', async () => {
		const org = await createWorkspace(req(), 'Test Co')
		expect(org.name).toBe('Test Co')

		const state = await resolveOnboarding(req())
		expect(state?.needsWorkspace).toBe(false)
		expect(state?.orgs.some((o) => o.id === org.id)).toBe(true)
	})

	it('rejects an empty workspace name', async () => {
		await expect(createWorkspace(req(), '   ')).rejects.toThrow(
			'Workspace name is required.',
		)
	})

	it('invites a teammate to a workspace', async () => {
		const org = await createWorkspace(req(), 'Invite Co')
		await expect(
			inviteTeammate(org.id, 'teammate@example.com', 'dev-admin'),
		).resolves.toBeUndefined()
	})

	it('reports demo data as unavailable outside project mode (demo mode has no bundles)', async () => {
		expect(await hasDemoData()).toBe(false)
	})

	it('is a fresh-install no-op in demo mode — isFreshProject only applies to project mode', async () => {
		// Demo mode always boots pre-seeded (task/author/article/…), and
		// `isFreshProject` is defined for project mode (`MAXSTACK_DATA_DIR`); it
		// reports `false` unconditionally outside it, matching `hasData: true`.
		expect(await isFreshProject()).toBe(false)
	})

	it('loading demo data outside project mode is a safe no-op', async () => {
		const result = await loadDemoData()
		// The demo backend's own resources are already seeded at boot, so there
		// is nothing left for the generic seeder to add.
		expect(result.resources).toEqual([])
	})
})
