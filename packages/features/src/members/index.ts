/**
 * Member management feature — org/member schema + a `MemberService` that owns
 * the last-owner invariant, extracted from mxscratchpad's admin RR route.
 */

export * from './schema.ts'
export type {
	AcceptInvitationInput,
	CreateInvitationInput,
	InvitableRole,
	InvitationErrorCode,
	MemberActionInput,
	MemberServiceOptions,
	RevokeInvitationInput,
	UpdateRoleInput,
} from './service.ts'
export {
	InvitationError,
	LastOwnerError,
	MemberService,
} from './service.ts'
