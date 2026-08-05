/**
 * Owned-code wiring for the first-run setup wizard (`routes/onboarding.tsx`,
 * issue #60 / task 63). Detects a "fresh install" — the viewer belongs to no
 * organization, or the project has no data yet — and drives the three wizard
 * steps: create a workspace (reuses the task-52 `MemberService`), optionally
 * invite teammates (same service), and load demo data. The demo-data step
 * delegates to `sprout.server.ts`'s `seedDemoData`/`isFreshProject` — the
 * same bundle-seed-first, generic-fallback mechanism the home page's
 * empty-state banner and `/onboarding/seed` already use, so there is exactly
 * one "what counts as demo data" answer in the app.
 *
 * Deliberately thin: every mutation is delegated to an existing service
 * (`MemberService`, `seedDemoData`) so this module is just request plumbing,
 * the same shape as `members.server.ts` and `settings.server.ts`.
 */

import type { SproutUser } from '@maxstack/core'
import { member, organization } from '@maxstack/features/members'
import { eq } from 'drizzle-orm'
import { getMemberService, type TeamMemberView } from './members.server'
import {
	getSprout,
	isFreshProject,
	resolveUser,
	seedDemoData,
} from './sprout.server'

type Db = Awaited<ReturnType<typeof getSprout>>['backend']['db']

export interface OnboardingState {
	user: SproutUser
	/** Orgs the viewer already belongs to (owner or otherwise). */
	orgs: { id: string; name: string }[]
	/** True when the viewer belongs to no organization yet. */
	needsWorkspace: boolean
	/** True once any spec resource has at least one row. */
	hasData: boolean
}

/** Load the wizard's state for the current request. Returns `null` only for a
 * fully anonymous visitor (the route sends them to sign in first). */
export async function resolveOnboarding(
	request: Request,
): Promise<OnboardingState | null> {
	const user = await resolveUser(request)
	if (!user) return null
	const { backend } = await getSprout()
	// Ensures the org/member/invitation DDL exists — this may be the very first
	// page a fresh install visits, before `/team` has had a chance to.
	await getMemberService()
	const orgs = await myOrgs(backend.db, user.id)
	return {
		user,
		orgs,
		needsWorkspace: orgs.length === 0,
		hasData: !(await isFreshProject()),
	}
}

async function myOrgs(
	db: Db,
	userId: string,
): Promise<{ id: string; name: string }[]> {
	const rows = (await db
		.select()
		.from(member)
		.where(eq(member.userId, userId))) as Array<{ organizationId: string }>
	if (rows.length === 0) return []
	const ids = new Set(rows.map((r) => r.organizationId))
	const all = (await db.select().from(organization)) as Array<{
		id: string
		name: string
	}>
	return all.filter((o) => ids.has(o.id))
}

/** Step 1: create a workspace owned by the viewer. */
export async function createWorkspace(
	request: Request,
	name: string,
): Promise<{ id: string; name: string }> {
	const user = await resolveUser(request)
	if (!user) throw new Error('Sign in to create a workspace.')
	const { backend } = await getSprout()
	const service = await getMemberService()
	const trimmed = name.trim()
	if (!trimmed) throw new Error('Workspace name is required.')
	const [org] = (await backend.db
		.insert(organization)
		.values({ id: crypto.randomUUID(), name: trimmed })
		.returning()) as Array<{ id: string; name: string }>
	if (!org) throw new Error('Failed to create workspace.')
	await service.addMember({
		organizationId: org.id,
		userId: user.id,
		role: 'owner',
	})
	return org
}

/** Step 2 (optional): invite a teammate to a workspace — the same primitive
 * `/team` uses, surfaced here so the wizard doesn't require a detour. */
export async function inviteTeammate(
	organizationId: string,
	email: string,
	inviterId: string,
): Promise<void> {
	const service = await getMemberService()
	await service.createInvitation({
		organizationId,
		email: email.trim(),
		role: 'member',
		inviterId,
	})
}

/** Step 3: populate the project's spec entities with representative sample
 * rows so a fresh install has something to explore. Idempotent. */
export async function loadDemoData(): Promise<{
	seeded: boolean
	resources: string[]
}> {
	return seedDemoData()
}

export type { TeamMemberView }
