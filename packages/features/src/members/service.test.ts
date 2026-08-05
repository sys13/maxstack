/**
 * Acceptance gate for the staged member service (12 cases). Reimplements
 * mxscratchpad's `database/plugins/organization.test.ts` on the canonical stack
 * (drizzle-orm/pg-core + pglite instead of libsql), and upgrades it: the
 * original asserted the last-owner rule as an inline boolean
 * (`expect(isLastOwner).toBe(true)`) that never called the code path. Here every
 * case drives the real `MemberService`, so the invariant is genuinely covered.
 */

import { eq } from 'drizzle-orm'
import type { drizzle } from 'drizzle-orm/pglite'
import { beforeEach, describe, expect, it } from 'vitest'
import { createMemoryAuditSink } from '../audit/audit-log.ts'
import { usePglite } from '../testing/pglite-fixture.ts'
import {
	invitation,
	MEMBERS_DDL,
	member,
	organization,
	user,
} from './schema.ts'
import { InvitationError, LastOwnerError, MemberService } from './service.ts'

type Db = ReturnType<typeof drizzle>

let db: Db
let audit: ReturnType<typeof createMemoryAuditSink>
let service: MemberService
let idCounter: number

const nextId = () => `id-${++idCounter}`

async function seedUser(name: string, email: string) {
	const [row] = await db
		.insert(user)
		.values({ id: nextId(), name, email })
		.returning()
	if (!row) throw new Error('seedUser failed')
	return row
}

async function seedOrg(name = 'Test Organization', slug = 'test-org') {
	const [row] = await db
		.insert(organization)
		.values({ id: nextId(), name, slug })
		.returning()
	if (!row) throw new Error('seedOrg failed')
	return row
}

const pg = usePglite(MEMBERS_DDL)

beforeEach(() => {
	idCounter = 0
	db = pg.db
	audit = createMemoryAuditSink()
	service = new MemberService({ db, audit, newId: nextId })
})

describe('MemberService', () => {
	it('1. creates an organization', async () => {
		const org = await seedOrg()
		expect(org.name).toBe('Test Organization')
		expect(org.slug).toBe('test-org')
	})

	it('2. adds members to an organization', async () => {
		const owner = await seedUser('Owner', 'owner@example.com')
		const memberUser = await seedUser('Member', 'member@example.com')
		const org = await seedOrg()

		const m1 = await service.addMember({
			organizationId: org.id,
			userId: owner.id,
			role: 'owner',
		})
		const m2 = await service.addMember({
			organizationId: org.id,
			userId: memberUser.id,
			role: 'member',
		})

		expect(m1.role).toBe('owner')
		expect(m2.role).toBe('member')
	})

	it('3. lists members for an organization', async () => {
		const u = await seedUser('User', 'u@example.com')
		const org = await seedOrg()
		await service.addMember({
			organizationId: org.id,
			userId: u.id,
			role: 'owner',
		})

		const members = await service.listMembers(org.id)
		expect(members).toHaveLength(1)
		expect(members[0]?.userId).toBe(u.id)
	})

	it('4. updates a member role (member -> admin)', async () => {
		const u = await seedUser('User', 'u@example.com')
		const owner = await seedUser('Owner', 'owner@example.com')
		const org = await seedOrg()
		await service.addMember({
			organizationId: org.id,
			userId: owner.id,
			role: 'owner',
		})
		const m = await service.addMember({
			organizationId: org.id,
			userId: u.id,
			role: 'member',
		})

		await service.updateRole({
			memberId: m.id,
			organizationId: org.id,
			newRole: 'admin',
			actorId: owner.id,
		})

		const [updated] = await db.select().from(member).where(eq(member.id, m.id))
		expect(updated?.role).toBe('admin')
	})

	it('5. promotes an admin to owner (now two owners)', async () => {
		const o1 = await seedUser('Owner', 'owner@example.com')
		const a1 = await seedUser('Admin', 'admin@example.com')
		const org = await seedOrg()
		await service.addMember({
			organizationId: org.id,
			userId: o1.id,
			role: 'owner',
		})
		const adminMember = await service.addMember({
			organizationId: org.id,
			userId: a1.id,
			role: 'admin',
		})

		await service.updateRole({
			memberId: adminMember.id,
			organizationId: org.id,
			newRole: 'owner',
			actorId: o1.id,
		})

		const owners = (await service.listMembers(org.id)).filter(
			(m) => m.role === 'owner',
		)
		expect(owners).toHaveLength(2)
	})

	it('6. can demote one of two owners (not the last owner)', async () => {
		const o1 = await seedUser('Owner1', 'o1@example.com')
		const o2 = await seedUser('Owner2', 'o2@example.com')
		const org = await seedOrg()
		const m1 = await service.addMember({
			organizationId: org.id,
			userId: o1.id,
			role: 'owner',
		})
		await service.addMember({
			organizationId: org.id,
			userId: o2.id,
			role: 'owner',
		})

		await service.updateRole({
			memberId: m1.id,
			organizationId: org.id,
			newRole: 'admin',
			actorId: o2.id,
		})

		const owners = (await service.listMembers(org.id)).filter(
			(m) => m.role === 'owner',
		)
		expect(owners).toHaveLength(1)
	})

	it('7. rejects demoting the last owner', async () => {
		const owner = await seedUser('Owner', 'owner@example.com')
		const org = await seedOrg()
		const m = await service.addMember({
			organizationId: org.id,
			userId: owner.id,
			role: 'owner',
		})

		await expect(
			service.updateRole({
				memberId: m.id,
				organizationId: org.id,
				newRole: 'member',
				actorId: owner.id,
			}),
		).rejects.toBeInstanceOf(LastOwnerError)

		// The role must be unchanged after the rejected demotion.
		const [after] = await db.select().from(member).where(eq(member.id, m.id))
		expect(after?.role).toBe('owner')
	})

	it('8. removes a non-owner member', async () => {
		const owner = await seedUser('Owner', 'owner@example.com')
		const other = await seedUser('Member', 'member@example.com')
		const org = await seedOrg()
		await service.addMember({
			organizationId: org.id,
			userId: owner.id,
			role: 'owner',
		})
		const m = await service.addMember({
			organizationId: org.id,
			userId: other.id,
			role: 'member',
		})

		await service.removeMember({
			memberId: m.id,
			organizationId: org.id,
			actorId: owner.id,
		})

		const remaining = await service.listMembers(org.id)
		expect(remaining).toHaveLength(1)
		expect(remaining[0]?.role).toBe('owner')
	})

	it('9. rejects removing the last owner', async () => {
		const owner = await seedUser('Owner', 'owner@example.com')
		const org = await seedOrg()
		const m = await service.addMember({
			organizationId: org.id,
			userId: owner.id,
			role: 'owner',
		})

		await expect(
			service.removeMember({
				memberId: m.id,
				organizationId: org.id,
				actorId: owner.id,
			}),
		).rejects.toBeInstanceOf(LastOwnerError)
		expect(await service.listMembers(org.id)).toHaveLength(1)
	})

	it('10. lets a non-owner leave the organization', async () => {
		const owner = await seedUser('Owner', 'owner@example.com')
		const leaver = await seedUser('Member', 'member@example.com')
		const org = await seedOrg()
		await service.addMember({
			organizationId: org.id,
			userId: owner.id,
			role: 'owner',
		})
		const m = await service.addMember({
			organizationId: org.id,
			userId: leaver.id,
			role: 'member',
		})

		await service.leaveOrganization({
			memberId: m.id,
			organizationId: org.id,
			actorId: leaver.id,
		})

		const remaining = await service.listMembers(org.id)
		expect(remaining).toHaveLength(1)
		expect(remaining[0]?.userId).toBe(owner.id)
	})

	it('11. rejects the last owner leaving', async () => {
		const owner = await seedUser('Owner', 'owner@example.com')
		const org = await seedOrg()
		const m = await service.addMember({
			organizationId: org.id,
			userId: owner.id,
			role: 'owner',
		})

		await expect(
			service.leaveOrganization({
				memberId: m.id,
				organizationId: org.id,
				actorId: owner.id,
			}),
		).rejects.toBeInstanceOf(LastOwnerError)
	})

	it('12. deleting an organization cascades its members', async () => {
		const u = await seedUser('User', 'u@example.com')
		const org = await seedOrg()
		await service.addMember({
			organizationId: org.id,
			userId: u.id,
			role: 'owner',
		})

		await service.deleteOrganization({
			organizationId: org.id,
			actorId: u.id,
		})

		const members = await db
			.select()
			.from(member)
			.where(eq(member.organizationId, org.id))
		expect(members).toHaveLength(0)
		// Every mutation the service performed was audited.
		expect(audit.entries.at(-1)?.action).toBe('delete_organization')
	})
})

describe('MemberService invitations', () => {
	it('13. creates a pending invitation and lists it', async () => {
		const owner = await seedUser('Owner', 'owner@example.com')
		const org = await seedOrg()
		await service.addMember({
			organizationId: org.id,
			userId: owner.id,
			role: 'owner',
		})

		const inv = await service.createInvitation({
			organizationId: org.id,
			email: 'Invitee@Example.com',
			role: 'member',
			inviterId: owner.id,
		})

		expect(inv.status).toBe('pending')
		// Email is normalized to lower-case.
		expect(inv.email).toBe('invitee@example.com')
		expect(inv.expiresAt.getTime()).toBeGreaterThan(Date.now())

		const pending = await service.listInvitations(org.id, {
			status: 'pending',
		})
		expect(pending).toHaveLength(1)
		expect(audit.entries.at(-1)?.action).toBe('invite_member')
	})

	it('14. accepting an invitation adds the user as a member', async () => {
		const owner = await seedUser('Owner', 'owner@example.com')
		const invitee = await seedUser('Invitee', 'invitee@example.com')
		const org = await seedOrg()
		await service.addMember({
			organizationId: org.id,
			userId: owner.id,
			role: 'owner',
		})
		const inv = await service.createInvitation({
			organizationId: org.id,
			email: 'invitee@example.com',
			role: 'admin',
			inviterId: owner.id,
		})

		const newMember = await service.acceptInvitation({
			invitationId: inv.id,
			userId: invitee.id,
			email: 'invitee@example.com',
		})

		expect(newMember.role).toBe('admin')
		expect(newMember.userId).toBe(invitee.id)

		const members = await service.listMembers(org.id)
		expect(members).toHaveLength(2)
		const [row] = await db
			.select()
			.from(invitation)
			.where(eq(invitation.id, inv.id))
		expect(row?.status).toBe('accepted')
		expect(audit.entries.at(-1)?.action).toBe('accept_invitation')
	})

	it('15. rejects accepting an invitation for a different email', async () => {
		const owner = await seedUser('Owner', 'owner@example.com')
		const org = await seedOrg()
		await service.addMember({
			organizationId: org.id,
			userId: owner.id,
			role: 'owner',
		})
		const inv = await service.createInvitation({
			organizationId: org.id,
			email: 'invitee@example.com',
			role: 'member',
			inviterId: owner.id,
		})

		await expect(
			service.acceptInvitation({
				invitationId: inv.id,
				userId: 'someone-else',
				email: 'other@example.com',
			}),
		).rejects.toBeInstanceOf(InvitationError)
	})

	it('16. rejects accepting an expired invitation and marks it expired', async () => {
		const owner = await seedUser('Owner', 'owner@example.com')
		const org = await seedOrg()
		await service.addMember({
			organizationId: org.id,
			userId: owner.id,
			role: 'owner',
		})
		// A clock fixed in the past makes the invite expire before "now".
		const past = new MemberService({
			db,
			audit,
			newId: nextId,
			now: () => new Date(Date.now() - 30 * 86_400_000),
		})
		const inv = await past.createInvitation({
			organizationId: org.id,
			email: 'stale@example.com',
			role: 'member',
			inviterId: owner.id,
			expiresInDays: 7,
		})

		await expect(
			service.acceptInvitation({ invitationId: inv.id, userId: 'stale' }),
		).rejects.toBeInstanceOf(InvitationError)

		const [row] = await db
			.select()
			.from(invitation)
			.where(eq(invitation.id, inv.id))
		expect(row?.status).toBe('expired')
	})

	it('17. rejects re-accepting an already-accepted invitation', async () => {
		const owner = await seedUser('Owner', 'owner@example.com')
		const invitee = await seedUser('Invitee', 'invitee@example.com')
		const org = await seedOrg()
		await service.addMember({
			organizationId: org.id,
			userId: owner.id,
			role: 'owner',
		})
		const inv = await service.createInvitation({
			organizationId: org.id,
			email: 'invitee@example.com',
			role: 'member',
			inviterId: owner.id,
		})
		await service.acceptInvitation({
			invitationId: inv.id,
			userId: invitee.id,
		})

		await expect(
			service.acceptInvitation({ invitationId: inv.id, userId: invitee.id }),
		).rejects.toBeInstanceOf(InvitationError)
	})

	it('18. revoking an invitation prevents acceptance', async () => {
		const owner = await seedUser('Owner', 'owner@example.com')
		const org = await seedOrg()
		await service.addMember({
			organizationId: org.id,
			userId: owner.id,
			role: 'owner',
		})
		const inv = await service.createInvitation({
			organizationId: org.id,
			email: 'invitee@example.com',
			role: 'member',
			inviterId: owner.id,
		})

		await service.revokeInvitation({
			invitationId: inv.id,
			organizationId: org.id,
			actorId: owner.id,
		})

		await expect(
			service.acceptInvitation({ invitationId: inv.id, userId: 'invitee' }),
		).rejects.toBeInstanceOf(InvitationError)
		expect(audit.entries.some((e) => e.action === 'revoke_invitation')).toBe(
			true,
		)
	})
})
