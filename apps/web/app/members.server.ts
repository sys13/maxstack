/**
 * Owned-code wiring for the team-settings page (`routes/team.tsx`).
 *
 * This is Bar-2 territory: hand-owned server code that composes the extracted
 * `MemberService` (`@maxstack/features/members`) into the running app. The
 * service owns the roles model (owner/admin/member), the last-owner invariant,
 * and the invitation flow; this module gives it a database, resolves the
 * request's active organization, and seeds a demo team so the page has members
 * to manage out of the box.
 *
 * The org/member/invitation tables live in the same backend as the app data and
 * auth (one pglite file / one Postgres schema). We materialize them here with an
 * idempotent DDL so the page works in the demo app without the `members` bundle
 * installed. `userId` / `inviterId` are plain text (not FKs) so a dev session
 * user (`resolveUser`'s `dev-admin` fallback) can own a team without a matching
 * row in auth's `user` table; display names resolve from auth's `user` table
 * when a real signed-in user id matches, else fall back to the raw id.
 */

import type { SproutUser } from '@maxstack/core'
import { user as authUser } from '@maxstack/features/auth'
import { MemberService, member, organization } from '@maxstack/features/members'
import { eq, inArray } from 'drizzle-orm'
import {
	getAuditSink,
	getSprout,
	ORG_COOKIE,
	resolveUser,
} from './sprout.server'

// The store backend's drizzle handle is intentionally untyped (`AnyDrizzle`);
// mirror that honesty here rather than restating drizzle's builder shape.
type Db = Awaited<ReturnType<typeof getSprout>>['backend']['db']

/** Idempotent DDL for the three team tables. Reuses auth's `user` table (no FK
 * on `userId`/`inviterId`, so a dev/session id owns a team without an auth
 * row); the org FK still cascades member/invitation deletes. Column names are
 * camelCase so this fallback matches the `members` bundle's from-spec tables
 *. */
const TEAM_DDL = `
CREATE TABLE IF NOT EXISTS organization (
  id text PRIMARY KEY,
  name text NOT NULL,
  slug text UNIQUE,
  logo text,
  "createdAt" timestamp NOT NULL DEFAULT now(),
  "updatedAt" timestamp NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS member (
  id text PRIMARY KEY,
  "organizationId" text NOT NULL REFERENCES organization(id) ON DELETE CASCADE,
  "userId" text NOT NULL,
  role text NOT NULL,
  "createdAt" timestamp NOT NULL DEFAULT now(),
  "updatedAt" timestamp NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS invitation (
  id text PRIMARY KEY,
  "organizationId" text NOT NULL REFERENCES organization(id) ON DELETE CASCADE,
  email text NOT NULL,
  role text NOT NULL,
  status text NOT NULL,
  "inviterId" text NOT NULL,
  "expiresAt" timestamp NOT NULL,
  "createdAt" timestamp NOT NULL DEFAULT now(),
  "updatedAt" timestamp NOT NULL DEFAULT now()
);
`

// One DDL run per process is enough (IF NOT EXISTS makes a repeat harmless, but
// the flag skips a round-trip on the hot path). Survives HMR via globalThis.
const teamScope = globalThis as typeof globalThis & {
	__maxstackTeamReady?: boolean
}

/** The `MemberService` bound to the app's backend + audit sink. */
export async function getMemberService(): Promise<MemberService> {
	const { backend } = await getSprout()
	if (!teamScope.__maxstackTeamReady) {
		await backend.exec(TEAM_DDL)
		teamScope.__maxstackTeamReady = true
	}
	return new MemberService({ db: backend.db, audit: getAuditSink() })
}

/** A member row enriched with a display label and whether it's the viewer. */
export interface TeamMemberView {
	id: string
	userId: string
	role: 'owner' | 'admin' | 'member'
	label: string
	isSelf: boolean
}

/** A pending invitation, serialized for the page. */
export interface InvitationView {
	id: string
	email: string
	role: 'admin' | 'member'
	expiresAt: string
	/** Who sent it — task 56 notifies this user when the invite is accepted. */
	inviterId: string
}

export interface TeamView {
	org: { id: string; name: string }
	user: SproutUser
	/** The viewer's own membership in this org, if any. */
	self: TeamMemberView | null
	members: TeamMemberView[]
	invitations: InvitationView[]
}

/** Resolve the active org id — the org-switcher cookie's claim, honored only
 * when the viewer is actually a member of it (mirrors `resolveActiveOrg`). */
function orgClaim(request: Request): string | undefined {
	const cookie = request.headers.get('cookie') ?? ''
	const match = cookie.match(new RegExp(`(?:^|;\\s*)${ORG_COOKIE}=([^;]+)`))
	return match?.[1] ? decodeURIComponent(match[1]) : undefined
}

/**
 * Load the viewer's team: the active org, its members (with display labels),
 * and pending invitations. Seeds a demo org owned by the viewer on first visit
 * so the page is never empty. Returns `null` only if there is no user at all
 * (strict anonymous), which the route turns into a sign-in prompt.
 */
export async function resolveTeam(request: Request): Promise<TeamView | null> {
	const user = await resolveUser(request)
	if (!user) return null
	const service = await getMemberService()
	const { backend } = await getSprout()

	await ensureDemoTeam(service, backend.db, user)

	// The viewer's memberships across all orgs; pick the claimed one if they're
	// in it, else their first.
	const mine = (await backend.db
		.select()
		.from(member)
		.where(eq(member.userId, user.id))) as Array<{ organizationId: string }>
	const claimed = orgClaim(request)
	const active = mine.find((m) => m.organizationId === claimed) ?? mine[0]
	if (!active) {
		// The viewer belongs to no org (e.g. they left their only team). Report an
		// empty team keyed to the first org so the page still renders.
		const [firstOrg] = await backend.db.select().from(organization).limit(1)
		if (!firstOrg) throw new Error('No organization to show')
		return {
			org: { id: firstOrg.id, name: firstOrg.name },
			user,
			self: null,
			members: await viewMembers(service, backend.db, firstOrg.id, user.id),
			invitations: await viewInvitations(service, firstOrg.id),
		}
	}

	const [org] = await backend.db
		.select()
		.from(organization)
		.where(eq(organization.id, active.organizationId))
	const members = await viewMembers(service, backend.db, org.id, user.id)
	return {
		org: { id: org.id, name: org.name },
		user,
		self: members.find((m) => m.isSelf) ?? null,
		members,
		invitations: await viewInvitations(service, org.id),
	}
}

/** Members of an org as view rows, labels resolved from auth's `user` table. */
async function viewMembers(
	service: MemberService,
	db: Db,
	orgId: string,
	selfId: string,
): Promise<TeamMemberView[]> {
	const rows = await service.listMembers(orgId)
	const labels = await resolveLabels(
		db,
		rows.map((r) => r.userId),
	)
	return rows
		.map((r) => ({
			id: r.id,
			userId: r.userId,
			role: r.role,
			label: labels.get(r.userId) ?? r.userId,
			isSelf: r.userId === selfId,
		}))
		.sort((a, b) => ROLE_RANK[a.role] - ROLE_RANK[b.role])
}

const ROLE_RANK = { owner: 0, admin: 1, member: 2 } as const

async function viewInvitations(
	service: MemberService,
	orgId: string,
): Promise<InvitationView[]> {
	const rows = await service.listInvitations(orgId, { status: 'pending' })
	return rows.map((r) => ({
		id: r.id,
		email: r.email,
		role: r.role,
		expiresAt: r.expiresAt.toISOString(),
		inviterId: r.inviterId,
	}))
}

/** Map user ids to a display label (name <email>) from auth's `user` table;
 * ids with no auth row (dev sessions, invite-derived ids) are simply omitted so
 * the caller falls back to the raw id. */
async function resolveLabels(
	db: Db,
	ids: string[],
): Promise<Map<string, string>> {
	const out = new Map<string, string>()
	const unique = [...new Set(ids)]
	if (unique.length === 0) return out
	try {
		const rows = (await db
			.select()
			.from(authUser)
			.where(inArray(authUser.id, unique))) as Array<{
			id: string
			name: string
			email: string
		}>
		for (const r of rows) out.set(r.id, `${r.name} (${r.email})`)
	} catch {
		// No auth user table (or unreadable) — labels fall back to raw ids.
	}
	return out
}

/**
 * Seed a demo team the first time the page is opened: an org owned by the
 * viewer, two example members, and one pending invitation — enough to exercise
 * role edits, removal, transfer, and accept without any prior setup. Idempotent:
 * does nothing once any organization exists.
 */
async function ensureDemoTeam(
	service: MemberService,
	db: Db,
	user: SproutUser,
): Promise<void> {
	const existing = (await db.select().from(organization).limit(1)) as unknown[]
	if (existing.length > 0) return
	const [org] = (await db
		.insert(organization)
		.values({ id: crypto.randomUUID(), name: 'Acme Inc', slug: 'acme' })
		.returning()) as Array<{ id: string }>
	if (!org) return
	await service.addMember({
		organizationId: org.id,
		userId: user.id,
		role: 'owner',
	})
	await service.addMember({
		organizationId: org.id,
		userId: 'alice@acme.test',
		role: 'admin',
	})
	await service.addMember({
		organizationId: org.id,
		userId: 'bob@acme.test',
		role: 'member',
	})
	await service.createInvitation({
		organizationId: org.id,
		email: 'carol@acme.test',
		role: 'member',
		inviterId: user.id,
	})
}
