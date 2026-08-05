/**
 * Member service — extracted from mxscratchpad's `routes/admin/organizations.tsx`
 * action. In the original the org/member mutations (updateRole, removeMember,
 * leaveOrganization, deleteOrganization) and their **last-owner protection**
 * lived inline in a React Router action, untested except as an inline boolean
 * assertion in `database/plugins/organization.test.ts`. This stages them as a
 * real, db-injected service so the invariant is enforced in one place and
 * covered by a drizzle acceptance test.
 *
 * Salvaged invariant: an organization can never lose its
 * last owner — demoting, removing, or leaving as the sole owner is rejected.
 *
 * Reference spec: `docs/reference-specs/member-management.md`.
 */

import { and, eq } from 'drizzle-orm'
import type { drizzle } from 'drizzle-orm/pglite'
import type { AuditSink } from '../audit/audit-log.ts'
import { invitation, type MemberRole, member, organization } from './schema.ts'

type Db = ReturnType<typeof drizzle>

/** A role an invitation may grant — ownership is never handed out by invite;
 * it is transferred to an existing member (see `updateRole`). */
export type InvitableRole = Exclude<MemberRole, 'owner'>

/** Thrown when an operation would leave an organization with no owner. */
export class LastOwnerError extends Error {
	readonly code = 'LAST_OWNER' as const
	constructor(message: string) {
		super(message)
		this.name = 'LastOwnerError'
	}
}

/** Reasons an invitation can't be accepted. Map to a 4xx in the route. */
export type InvitationErrorCode =
	| 'NOT_FOUND'
	| 'NOT_PENDING'
	| 'EXPIRED'
	| 'EMAIL_MISMATCH'

/** Thrown when an invitation can't be created or accepted. */
export class InvitationError extends Error {
	readonly code: InvitationErrorCode
	constructor(message: string, code: InvitationErrorCode) {
		super(message)
		this.name = 'InvitationError'
		this.code = code
	}
}

export interface MemberServiceOptions {
	db: Db
	/** Optional audit sink; each mutation records an entry when provided. */
	audit?: AuditSink
	/** Generates ids for new rows. Defaults to `crypto.randomUUID`. */
	newId?: () => string
	/** The clock — invitation expiry is computed against it. Defaults to `Date`. */
	now?: () => Date
}

export interface CreateInvitationInput {
	organizationId: string
	email: string
	role: InvitableRole
	inviterId: string
	/** How long the invite stays acceptable. Defaults to 7 days. */
	expiresInDays?: number
}

export interface AcceptInvitationInput {
	invitationId: string
	/** The accepting user's id — becomes the new member's `userId`. */
	userId: string
	/** When given, must match the address the invite was sent to. */
	email?: string
}

export interface RevokeInvitationInput {
	invitationId: string
	organizationId: string
	actorId: string
}

export interface UpdateRoleInput {
	memberId: string
	organizationId: string
	newRole: MemberRole
	actorId: string
}

export interface MemberActionInput {
	memberId: string
	organizationId: string
	actorId: string
}

export class MemberService {
	readonly #db: Db
	readonly #audit?: AuditSink
	readonly #newId: () => string
	readonly #now: () => Date

	constructor(options: MemberServiceOptions) {
		this.#db = options.db
		this.#audit = options.audit
		this.#newId = options.newId ?? (() => crypto.randomUUID())
		this.#now = options.now ?? (() => new Date())
	}

	/** All members of an organization. */
	async listMembers(organizationId: string) {
		return this.#db
			.select()
			.from(member)
			.where(eq(member.organizationId, organizationId))
	}

	/** Add a member to an organization. */
	async addMember(input: {
		organizationId: string
		userId: string
		role: MemberRole
	}) {
		const [row] = await this.#db
			.insert(member)
			.values({
				id: this.#newId(),
				organizationId: input.organizationId,
				userId: input.userId,
				role: input.role,
			})
			.returning()
		if (!row) throw new Error('Failed to insert member')
		return row
	}

	/**
	 * Change a member's role. Rejects demoting the sole owner (would leave the
	 * org ownerless).
	 */
	async updateRole(input: UpdateRoleInput) {
		const members = await this.listMembers(input.organizationId)
		const target = members.find((m) => m.id === input.memberId)
		if (!target) throw new Error(`Member not found: ${input.memberId}`)

		const ownerCount = members.filter((m) => m.role === 'owner').length
		if (
			target.role === 'owner' &&
			ownerCount === 1 &&
			input.newRole !== 'owner'
		) {
			throw new LastOwnerError(
				'Cannot change the role of the last owner. Transfer ownership first.',
			)
		}

		const [row] = await this.#db
			.update(member)
			.set({ role: input.newRole, updatedAt: new Date() })
			.where(eq(member.id, input.memberId))
			.returning()

		await this.#record(
			input.actorId,
			'update_member_role',
			'member',
			input.memberId,
			{
				organizationId: input.organizationId,
				newRole: input.newRole,
			},
		)
		return row
	}

	/** Remove a member. Rejects removing the sole owner. */
	async removeMember(input: MemberActionInput) {
		await this.#assertNotLastOwner(
			input,
			'Cannot remove the last owner. Transfer ownership first.',
		)
		await this.#db.delete(member).where(eq(member.id, input.memberId))
		await this.#record(
			input.actorId,
			'remove_member',
			'member',
			input.memberId,
			{
				organizationId: input.organizationId,
			},
		)
	}

	/** A member leaves the org. Rejects the sole owner leaving. */
	async leaveOrganization(input: MemberActionInput) {
		await this.#assertNotLastOwner(
			input,
			'Cannot leave as the last owner. Transfer ownership or delete the organization first.',
		)
		await this.#db.delete(member).where(eq(member.id, input.memberId))
		await this.#record(
			input.actorId,
			'leave_organization',
			'member',
			input.memberId,
			{
				organizationId: input.organizationId,
			},
		)
	}

	/** Delete an organization (members cascade via the FK). */
	async deleteOrganization(input: { organizationId: string; actorId: string }) {
		await this.#db
			.delete(organization)
			.where(eq(organization.id, input.organizationId))
		await this.#record(
			input.actorId,
			'delete_organization',
			'organization',
			input.organizationId,
		)
	}

	// --- Invitations ---------------------------------------------------------

	/** Pending (or optionally all) invitations for an organization. */
	async listInvitations(organizationId: string, opts?: { status?: string }) {
		const rows = await this.#db
			.select()
			.from(invitation)
			.where(eq(invitation.organizationId, organizationId))
		return opts?.status ? rows.filter((i) => i.status === opts.status) : rows
	}

	/**
	 * Invite someone to the org by email. The invite is `pending` until accepted
	 * or it expires; the granted role can't be `owner` (ownership is transferred,
	 * never invited — see `updateRole`).
	 */
	async createInvitation(input: CreateInvitationInput) {
		const now = this.#now()
		const expiresAt = new Date(
			now.getTime() + (input.expiresInDays ?? 7) * 86_400_000,
		)
		const email = input.email.trim().toLowerCase()
		const [row] = await this.#db
			.insert(invitation)
			.values({
				id: this.#newId(),
				organizationId: input.organizationId,
				email,
				role: input.role,
				status: 'pending',
				inviterId: input.inviterId,
				expiresAt,
			})
			.returning()
		if (!row) throw new Error('Failed to create invitation')
		await this.#record(input.inviterId, 'invite_member', 'invitation', row.id, {
			organizationId: input.organizationId,
			email,
			role: input.role,
		})
		return row
	}

	/**
	 * Accept a pending invitation, adding the accepting user as a member with the
	 * invited role. Rejects a missing/spent/expired invite (marking it `expired`
	 * on the way), and — when an email is supplied — one addressed to someone
	 * else. Idempotent for a user who is already a member.
	 */
	async acceptInvitation(input: AcceptInvitationInput) {
		const [inv] = await this.#db
			.select()
			.from(invitation)
			.where(eq(invitation.id, input.invitationId))
		if (!inv) {
			throw new InvitationError('Invitation not found.', 'NOT_FOUND')
		}
		if (inv.status !== 'pending') {
			throw new InvitationError(
				`Invitation is ${inv.status}, not pending.`,
				'NOT_PENDING',
			)
		}
		if (inv.expiresAt.getTime() < this.#now().getTime()) {
			await this.#db
				.update(invitation)
				.set({ status: 'expired', updatedAt: this.#now() })
				.where(eq(invitation.id, inv.id))
			throw new InvitationError('Invitation has expired.', 'EXPIRED')
		}
		if (input.email && input.email.trim().toLowerCase() !== inv.email) {
			throw new InvitationError(
				'Invitation was sent to a different email.',
				'EMAIL_MISMATCH',
			)
		}

		const existing = (await this.listMembers(inv.organizationId)).find(
			(m) => m.userId === input.userId,
		)
		const memberRow =
			existing ??
			(await this.addMember({
				organizationId: inv.organizationId,
				userId: input.userId,
				role: inv.role,
			}))

		await this.#db
			.update(invitation)
			.set({ status: 'accepted', updatedAt: this.#now() })
			.where(eq(invitation.id, inv.id))
		await this.#record(
			input.userId,
			'accept_invitation',
			'invitation',
			inv.id,
			{ organizationId: inv.organizationId },
		)
		return memberRow
	}

	/** Revoke a pending invitation (marks it `revoked`). */
	async revokeInvitation(input: RevokeInvitationInput) {
		await this.#db
			.update(invitation)
			.set({ status: 'revoked', updatedAt: this.#now() })
			.where(
				and(
					eq(invitation.id, input.invitationId),
					eq(invitation.organizationId, input.organizationId),
				),
			)
		await this.#record(
			input.actorId,
			'revoke_invitation',
			'invitation',
			input.invitationId,
			{ organizationId: input.organizationId },
		)
	}

	async #assertNotLastOwner(input: MemberActionInput, message: string) {
		const [target] = await this.#db
			.select()
			.from(member)
			.where(
				and(
					eq(member.id, input.memberId),
					eq(member.organizationId, input.organizationId),
				),
			)
		if (!target) throw new Error(`Member not found: ${input.memberId}`)
		if (target.role !== 'owner') return

		const owners = (await this.listMembers(input.organizationId)).filter(
			(m) => m.role === 'owner',
		)
		if (owners.length === 1) throw new LastOwnerError(message)
	}

	async #record(
		userId: string,
		action: string,
		resource: string,
		resourceId: string,
		metadata?: Record<string, unknown>,
	) {
		if (!this.#audit) return
		await this.#audit({ userId, action, resource, resourceId, metadata })
	}
}
