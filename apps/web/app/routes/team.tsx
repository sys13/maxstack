/**
 * Team settings — an owned-code page (Bar-2) over the extracted `MemberService`.
 *
 * Everything the service exposes is surfaced here as tailored UI: the member
 * list with per-row role editing, invite-by-email + accept/revoke of pending
 * invitations, remove/leave, and transfer-ownership. The service enforces the
 * last-owner invariant and records every mutation through the audit sink; this
 * route just maps its errors (`LastOwnerError`, `InvitationError`) to a flash
 * message and revalidates on success.
 *
 * The accept flow derives the new member's user id from the invitation's email
 * (the demo has no separate invitee session), so an owner can invite by email
 * and watch the accepted member appear — the page's exit criterion.
 */

import {
	InvitationError,
	LastOwnerError,
	type MemberRole,
} from '@maxstack/features/members'
import { Alert, Button } from '@maxstack/ui'
import {
	data,
	Form,
	redirect,
	useActionData,
	useNavigation,
} from 'react-router'
import { getMemberService, resolveTeam } from '~/members.server'
import { getNotificationService, resolveEmail } from '~/notifications.server'
import { getSprout } from '~/sprout.server'
import type { Route } from './+types/team'

const ROLES: MemberRole[] = ['owner', 'admin', 'member']

export async function loader({ request }: Route.LoaderArgs) {
	const team = await resolveTeam(request)
	if (!team) {
		throw data({ error: 'Sign in to manage your team.' }, { status: 401 })
	}
	return team
}

export async function action({ request }: Route.ActionArgs) {
	const team = await resolveTeam(request)
	if (!team) return data({ error: 'Not signed in.' }, { status: 401 })
	const service = await getMemberService()
	const form = await request.formData()
	const intent = String(form.get('intent') ?? '')
	const orgId = team.org.id
	const actorId = team.user.id

	try {
		switch (intent) {
			case 'invite': {
				const email = String(form.get('email') ?? '').trim()
				const role = String(form.get('role') ?? 'member') as 'admin' | 'member'
				if (!email)
					return data({ error: 'Email is required.' }, { status: 400 })
				await service.createInvitation({
					organizationId: orgId,
					email,
					role: role === 'admin' ? 'admin' : 'member',
					inviterId: actorId,
				})
				break
			}
			case 'accept': {
				const invitationId = String(form.get('invitationId') ?? '')
				// The invite carries the address it was sent to; that becomes the new
				// member's user id (no separate invitee session in the demo).
				const inv = team.invitations.find((i) => i.id === invitationId)
				if (!inv)
					return data({ error: 'Invitation not found.' }, { status: 404 })
				await service.acceptInvitation({
					invitationId,
					userId: inv.email,
					email: inv.email,
				})
				// Task 56: notify the inviter their invite was accepted — the same
				// call-site pattern `service` uses for the audit sink, since there's
				// no event bus yet (task 58).
				//
				// The call site no longer says how loud this is: `invitation-accepted`
				// is a declared type, so the digest-vs-immediate decision
				// belongs to the declaration and the inviter's preference. `dedupeKey`
				// is the invitation id, so accepting twice — a double-submitted form, a
				// retried action — cannot mail twice.
				{
					const { backend } = await getSprout()
					const inviterEmail = await resolveEmail(backend.db, inv.inviterId)
					const notifications = await getNotificationService()
					await notifications.notify({
						userId: inv.inviterId,
						type: 'invitation-accepted',
						title: 'New team member',
						body: `${inv.email} accepted your invitation and joined ${team.org.name}.`,
						url: '/team',
						email: inviterEmail,
						dedupeKey: `invitation-accepted:${invitationId}`,
					})
				}
				break
			}
			case 'revoke': {
				await service.revokeInvitation({
					invitationId: String(form.get('invitationId') ?? ''),
					organizationId: orgId,
					actorId,
				})
				break
			}
			case 'updateRole': {
				await service.updateRole({
					memberId: String(form.get('memberId') ?? ''),
					organizationId: orgId,
					newRole: String(form.get('newRole') ?? 'member') as MemberRole,
					actorId,
				})
				break
			}
			case 'remove': {
				await service.removeMember({
					memberId: String(form.get('memberId') ?? ''),
					organizationId: orgId,
					actorId,
				})
				break
			}
			case 'leave': {
				if (!team.self) {
					return data({ error: 'You are not a member.' }, { status: 400 })
				}
				await service.leaveOrganization({
					memberId: team.self.id,
					organizationId: orgId,
					actorId,
				})
				break
			}
			case 'transfer': {
				// Promote the target to owner (always allowed), then step the current
				// owner down to admin — a two-step transfer over `updateRole`.
				if (team.self?.role !== 'owner') {
					return data(
						{ error: 'Only an owner can transfer ownership.' },
						{ status: 403 },
					)
				}
				const memberId = String(form.get('memberId') ?? '')
				await service.updateRole({
					memberId,
					organizationId: orgId,
					newRole: 'owner',
					actorId,
				})
				await service.updateRole({
					memberId: team.self.id,
					organizationId: orgId,
					newRole: 'admin',
					actorId,
				})
				break
			}
			default:
				return data({ error: `Unknown action: ${intent}` }, { status: 400 })
		}
	} catch (err) {
		if (err instanceof LastOwnerError || err instanceof InvitationError) {
			return data({ error: err.message }, { status: 409 })
		}
		throw err
	}

	return redirect('/team')
}

export default function TeamSettings({ loaderData }: Route.ComponentProps) {
	const team = loaderData
	const actionData = useActionData<typeof action>()
	const nav = useNavigation()
	const busy = nav.state !== 'idle'
	const canManage = team.self?.role === 'owner' || team.self?.role === 'admin'
	const isOwner = team.self?.role === 'owner'

	return (
		<main className="mx-auto max-w-2xl px-6 py-10">
			<h1 className="text-2xl font-semibold">Team settings</h1>
			<p className="mt-1 text-sm text-muted-foreground">
				{team.org.name}
				{team.self ? (
					<>
						{' · '}you are{' '}
						<span className="font-medium text-foreground">
							{team.self.role}
						</span>
					</>
				) : (
					' · you are not a member'
				)}
			</p>

			{actionData?.error ? (
				<Alert variant="destructive" role="alert" className="mt-4">
					{actionData.error}
				</Alert>
			) : null}

			{/* Members */}
			<section className="mt-8">
				<h2 className="mb-3 text-lg font-medium">Members</h2>
				<ul className="divide-y divide-border rounded-md border border-border">
					{team.members.map((m) => (
						<li
							key={m.id}
							className="flex flex-wrap items-center gap-3 px-4 py-3"
						>
							<span className="min-w-0 flex-1 truncate text-sm">
								{m.label}
								{m.isSelf ? (
									<span className="ml-1 text-muted-foreground">(you)</span>
								) : null}
							</span>

							{canManage ? (
								<Form method="post" className="flex items-center gap-2">
									<input type="hidden" name="intent" value="updateRole" />
									<input type="hidden" name="memberId" value={m.id} />
									<select
										name="newRole"
										defaultValue={m.role}
										disabled={busy}
										onChange={(e) => e.currentTarget.form?.requestSubmit()}
										className="h-8 rounded-md border border-border bg-transparent px-2 text-sm"
									>
										{ROLES.map((r) => (
											<option key={r} value={r}>
												{r}
											</option>
										))}
									</select>
								</Form>
							) : (
								<span className="text-sm text-muted-foreground">{m.role}</span>
							)}

							{isOwner && !m.isSelf ? (
								<Form method="post">
									<input type="hidden" name="intent" value="transfer" />
									<input type="hidden" name="memberId" value={m.id} />
									<button
										type="submit"
										disabled={busy}
										className="h-8 cursor-pointer rounded-md border border-border bg-transparent px-2 text-xs text-muted-foreground hover:text-foreground"
										title="Make this member the owner and step yourself down to admin"
									>
										Make owner
									</button>
								</Form>
							) : null}

							{canManage && !m.isSelf ? (
								<Form method="post">
									<input type="hidden" name="intent" value="remove" />
									<input type="hidden" name="memberId" value={m.id} />
									<Button
										type="submit"
										variant="destructive"
										size="sm"
										disabled={busy}
										className="px-2 text-xs"
									>
										Remove
									</Button>
								</Form>
							) : null}
						</li>
					))}
				</ul>
			</section>

			{/* Invitations */}
			{canManage ? (
				<section className="mt-8">
					<h2 className="mb-3 text-lg font-medium">Invite a member</h2>
					<Form
						method="post"
						className="flex flex-wrap items-end gap-2"
						key={team.members.length}
					>
						<input type="hidden" name="intent" value="invite" />
						<label className="flex flex-1 flex-col gap-1">
							<span className="text-xs text-muted-foreground">Email</span>
							<input
								name="email"
								type="email"
								required
								placeholder="teammate@example.com"
								disabled={busy}
								className="h-9 rounded-md border border-border bg-transparent px-3 text-sm"
							/>
						</label>
						<label className="flex flex-col gap-1">
							<span className="text-xs text-muted-foreground">Role</span>
							<select
								name="role"
								defaultValue="member"
								disabled={busy}
								className="h-9 rounded-md border border-border bg-transparent px-2 text-sm"
							>
								<option value="member">member</option>
								<option value="admin">admin</option>
							</select>
						</label>
						<button
							type="submit"
							disabled={busy}
							className="h-9 cursor-pointer rounded-md bg-primary px-4 text-sm font-medium text-primary-foreground hover:opacity-90"
						>
							Send invite
						</button>
					</Form>

					{team.invitations.length > 0 ? (
						<ul className="mt-4 divide-y divide-border rounded-md border border-border">
							{team.invitations.map((inv) => (
								<li
									key={inv.id}
									className="flex flex-wrap items-center gap-3 px-4 py-3"
								>
									<span className="min-w-0 flex-1 truncate text-sm">
										{inv.email}
										<span className="ml-2 rounded bg-muted px-1.5 py-0.5 text-xs text-muted-foreground">
											{inv.role} · pending
										</span>
									</span>
									<Form method="post">
										<input type="hidden" name="intent" value="accept" />
										<input type="hidden" name="invitationId" value={inv.id} />
										<button
											type="submit"
											disabled={busy}
											className="h-8 cursor-pointer rounded-md border border-border bg-transparent px-2 text-xs hover:text-foreground"
										>
											Accept
										</button>
									</Form>
									<Form method="post">
										<input type="hidden" name="intent" value="revoke" />
										<input type="hidden" name="invitationId" value={inv.id} />
										<button
											type="submit"
											disabled={busy}
											className="h-8 cursor-pointer rounded-md border border-border bg-transparent px-2 text-xs text-muted-foreground hover:text-foreground"
										>
											Revoke
										</button>
									</Form>
								</li>
							))}
						</ul>
					) : (
						<p className="mt-3 text-sm text-muted-foreground">
							No pending invitations.
						</p>
					)}
				</section>
			) : null}

			{/* Leave */}
			{team.self ? (
				<section className="mt-10 border-t border-border pt-6">
					<Form method="post">
						<input type="hidden" name="intent" value="leave" />
						<Button type="submit" variant="destructive" disabled={busy}>
							Leave team
						</Button>
					</Form>
				</section>
			) : null}
		</main>
	)
}
