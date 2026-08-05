/**
 * Account settings — an owned-code page (Bar-2) over better-auth's own
 * mutation endpoints (task 50) plus the new `PreferencesService`.
 *
 * Sections: profile (name), change password, sessions/devices (list + revoke +
 * sign-out-others), email/notification preferences, a link out to `/team` for
 * org settings (task 52 already owns that surface), and a danger-zone account
 * deletion that requires both the current password and a typed "DELETE".
 *
 * Password/sessions/delete all require a real better-auth session — under the
 * dev fallback identity (no session cookie) those sections render a "sign in"
 * notice instead of silently no-op'ing.
 */

import { Alert, Button, PreferencesForm, Timestamp } from '@maxstack/ui'
import {
	data,
	Form,
	redirect,
	useActionData,
	useNavigation,
} from 'react-router'
import {
	applyPreferencesForm,
	eraseAccountData,
	getConsentService,
	resolveSettings,
	TERMS_VERSION,
} from '~/settings.server'
import { getAuth } from '~/sprout.server'
import type { Route } from './+types/settings'

export async function loader({ request }: Route.LoaderArgs) {
	return resolveSettings(request)
}

export async function action({ request }: Route.ActionArgs) {
	const settings = await resolveSettings(request)
	const auth = await getAuth()
	const form = await request.formData()
	const intent = String(form.get('intent') ?? '')

	try {
		switch (intent) {
			case 'updateProfile': {
				if (!settings.hasSession) {
					return data(
						{ error: 'Sign in to edit your profile.' },
						{ status: 401 },
					)
				}
				const name = String(form.get('name') ?? '').trim()
				if (!name) return data({ error: 'Name is required.' }, { status: 400 })
				await auth.api.updateUser({ headers: request.headers, body: { name } })
				break
			}
			case 'changePassword': {
				if (!settings.hasSession) {
					return data(
						{ error: 'Sign in to change your password.' },
						{ status: 401 },
					)
				}
				const currentPassword = String(form.get('currentPassword') ?? '')
				const newPassword = String(form.get('newPassword') ?? '')
				if (!currentPassword || !newPassword) {
					return data(
						{ error: 'Current and new password are both required.' },
						{ status: 400 },
					)
				}
				await auth.api.changePassword({
					headers: request.headers,
					body: { currentPassword, newPassword },
				})
				break
			}
			case 'revokeSession': {
				if (!settings.hasSession) {
					return data({ error: 'Sign in to manage sessions.' }, { status: 401 })
				}
				const token = String(form.get('token') ?? '')
				await auth.api.revokeSession({
					headers: request.headers,
					body: { token },
				})
				break
			}
			case 'revokeOtherSessions': {
				if (!settings.hasSession) {
					return data({ error: 'Sign in to manage sessions.' }, { status: 401 })
				}
				await auth.api.revokeOtherSessions({ headers: request.headers })
				break
			}
			case 'acceptTerms': {
				const consent = await getConsentService()
				await consent.record({
					userId: settings.userId,
					type: 'terms',
					version: TERMS_VERSION,
				})
				break
			}
			case 'updatePreferences': {
				// Reads whatever the declarations declare — this action
				// names no preference, so adding one needs no edit here.
				await applyPreferencesForm(request, 'user', form)
				break
			}
			case 'updateOrgPreferences': {
				// Owner/admin only, refused by `PreferencesService` itself.
				await applyPreferencesForm(request, 'organization', form)
				break
			}
			case 'deleteAccount': {
				if (!settings.hasSession) {
					return data(
						{ error: 'Sign in to delete your account.' },
						{ status: 401 },
					)
				}
				const confirmation = String(form.get('confirmation') ?? '')
				const password = String(form.get('password') ?? '')
				if (confirmation !== 'DELETE') {
					return data(
						{ error: 'Type DELETE to confirm account deletion.' },
						{ status: 400 },
					)
				}
				// Erase owned app data first — `deleteUser` below only
				// ever removed the auth `user` row, never the rows this user owns
				// (comments, etc). Erase before delete: `eraseAccountData` resolves
				// the user from this same request, which still has a valid session.
				await eraseAccountData(request)
				await auth.api.deleteUser({
					headers: request.headers,
					body: { password },
				})
				break
			}
			default:
				return data({ error: `Unknown action: ${intent}` }, { status: 400 })
		}
	} catch (err) {
		const message = err instanceof Error ? err.message : 'Something went wrong.'
		return data({ error: message }, { status: 400 })
	}

	return redirect('/settings')
}

export default function AccountSettings({ loaderData }: Route.ComponentProps) {
	const settings = loaderData
	const actionData = useActionData<typeof action>()
	const nav = useNavigation()
	const busy = nav.state !== 'idle'
	// `editable` is the service's answer to "may this viewer write org defaults",
	// computed with the same check the write path enforces — so the button is
	// absent exactly when the action would refuse.
	const canEditOrgPreferences = settings.organizationPreferences.some((group) =>
		group.fields.some((field) => field.editable),
	)

	return (
		<main className="mx-auto max-w-2xl px-6 py-10">
			<h1 className="text-2xl font-semibold">Account settings</h1>
			<p className="mt-1 text-sm text-muted-foreground">
				{settings.email ?? settings.userId}
			</p>

			{actionData?.error ? (
				<Alert variant="destructive" role="alert" className="mt-4">
					{actionData.error}
				</Alert>
			) : null}

			{!settings.hasSession ? (
				<p className="mt-4 rounded-md border border-border bg-muted px-3 py-2 text-sm text-muted-foreground">
					<a
						href="/login"
						className="text-foreground underline underline-offset-2"
					>
						Sign in
					</a>{' '}
					to edit your profile, change your password, manage sessions, or delete
					your account. Notification preferences below still work.
				</p>
			) : (
				<Form method="post" action="/login" className="mt-4">
					<input type="hidden" name="intent" value="signOut" />
					<button
						type="submit"
						disabled={busy}
						className="h-8 cursor-pointer rounded-md border border-border bg-transparent px-3 text-xs font-medium hover:bg-muted disabled:opacity-50"
					>
						Sign out
					</button>
				</Form>
			)}

			{/* Profile */}
			<section className="mt-8">
				<h2 className="mb-3 text-lg font-medium">Profile</h2>
				<Form method="post" className="flex flex-wrap items-end gap-2">
					<input type="hidden" name="intent" value="updateProfile" />
					<label className="flex flex-1 flex-col gap-1">
						<span className="text-xs text-muted-foreground">Name</span>
						<input
							name="name"
							type="text"
							required
							defaultValue={settings.name ?? ''}
							disabled={busy || !settings.hasSession}
							className="h-9 rounded-md border border-border bg-transparent px-3 text-sm"
						/>
					</label>
					<button
						type="submit"
						disabled={busy || !settings.hasSession}
						className="h-9 cursor-pointer rounded-md bg-primary px-4 text-sm font-medium text-primary-foreground hover:opacity-90 disabled:opacity-50"
					>
						Save
					</button>
				</Form>
			</section>

			{/* Change password */}
			<section className="mt-8 border-t border-border pt-6">
				<h2 className="mb-3 text-lg font-medium">Change password</h2>
				<Form method="post" className="flex flex-col gap-2">
					<input type="hidden" name="intent" value="changePassword" />
					<label className="flex flex-col gap-1">
						<span className="text-xs text-muted-foreground">
							Current password
						</span>
						<input
							name="currentPassword"
							type="password"
							required
							disabled={busy || !settings.hasSession}
							className="h-9 rounded-md border border-border bg-transparent px-3 text-sm"
						/>
					</label>
					<label className="flex flex-col gap-1">
						<span className="text-xs text-muted-foreground">New password</span>
						<input
							name="newPassword"
							type="password"
							required
							minLength={8}
							disabled={busy || !settings.hasSession}
							className="h-9 rounded-md border border-border bg-transparent px-3 text-sm"
						/>
					</label>
					<button
						type="submit"
						disabled={busy || !settings.hasSession}
						className="h-9 w-fit cursor-pointer rounded-md border border-border bg-transparent px-4 text-sm font-medium hover:bg-muted disabled:opacity-50"
					>
						Update password
					</button>
				</Form>
			</section>

			{/* Sessions / devices */}
			<section className="mt-8 border-t border-border pt-6">
				<h2 className="mb-3 text-lg font-medium">Sessions & devices</h2>
				{settings.hasSession && settings.sessions.length > 0 ? (
					<>
						<ul className="divide-y divide-border rounded-md border border-border">
							{settings.sessions.map((s) => (
								<li
									key={s.token}
									className="flex flex-wrap items-center gap-3 px-4 py-3"
								>
									<span className="min-w-0 flex-1 truncate text-sm">
										{s.userAgent ?? 'Unknown device'}
										<span className="ml-2 text-xs text-muted-foreground">
											{s.ipAddress ?? 'unknown ip'} ·{' '}
											<Timestamp iso={new Date(s.createdAt).toISOString()} />
										</span>
										{s.current ? (
											<span className="ml-2 rounded bg-muted px-1.5 py-0.5 text-xs text-muted-foreground">
												this device
											</span>
										) : null}
									</span>
									{!s.current ? (
										<Form method="post">
											<input
												type="hidden"
												name="intent"
												value="revokeSession"
											/>
											<input type="hidden" name="token" value={s.token} />
											<button
												type="submit"
												disabled={busy}
												className="h-8 cursor-pointer rounded-md border border-border bg-transparent px-2 text-xs text-muted-foreground hover:text-foreground"
											>
												Sign out
											</button>
										</Form>
									) : null}
								</li>
							))}
						</ul>
						<Form method="post" className="mt-3">
							<input type="hidden" name="intent" value="revokeOtherSessions" />
							<button
								type="submit"
								disabled={busy}
								className="h-8 cursor-pointer rounded-md border border-border bg-transparent px-2 text-xs text-muted-foreground hover:text-foreground"
							>
								Sign out other devices
							</button>
						</Form>
					</>
				) : (
					<p className="text-sm text-muted-foreground">
						{settings.hasSession
							? 'No other active sessions.'
							: 'Sign in to see your sessions.'}
					</p>
				)}
			</section>

			{/* Terms acceptance — no signup form exists in this app to
			    hook a checkbox into (see settings.server.ts's SettingsView doc), so
			    this is the fallback "first authenticated surface" prompt. */}
			<section className="mt-8 border-t border-border pt-6">
				<h2 className="mb-3 text-lg font-medium">Terms of Service</h2>
				{settings.termsAccepted ? (
					<p className="text-sm text-muted-foreground">
						You’ve accepted version {settings.termsVersion}.
					</p>
				) : (
					<Form method="post" className="flex flex-wrap items-center gap-3">
						<input type="hidden" name="intent" value="acceptTerms" />
						<label className="flex items-center gap-2 text-sm">
							<input type="checkbox" required disabled={busy} />I accept the
							Terms of Service (v{settings.termsVersion})
						</label>
						<button
							type="submit"
							disabled={busy}
							className="h-8 cursor-pointer rounded-md border border-border bg-transparent px-3 text-xs font-medium hover:bg-muted"
						>
							Accept
						</button>
					</Form>
				)}
			</section>

			{/* Preferences — derived from the declarations. This page
			    lists no preference by name: `<PreferencesForm>` renders whatever
			    `PreferencesService.describe` returns, so a new preference is one
			    declaration rather than a column, a field, a loader and an action. */}
			<section className="mt-8 border-t border-border pt-6">
				<h2 className="mb-3 text-lg font-medium">Preferences</h2>
				<Form method="post" className="flex flex-col gap-4">
					<input type="hidden" name="intent" value="updatePreferences" />
					<PreferencesForm
						groups={settings.preferences}
						busy={busy}
						emptyState={
							<p className="text-sm text-muted-foreground">
								This app declares no preferences yet.
							</p>
						}
					/>
					{settings.preferences.length > 0 ? (
						<button
							type="submit"
							disabled={busy}
							className="h-9 w-fit cursor-pointer rounded-md border border-border bg-transparent px-4 text-sm font-medium hover:bg-muted"
						>
							Save preferences
						</button>
					) : null}
				</Form>
			</section>

			{/* Organization defaults — the same derived form at the org scope. A
			    member sees it read-only, so an inherited value is explicable. */}
			{settings.organizationPreferences.length > 0 ? (
				<section className="mt-8 border-t border-border pt-6">
					<h2 className="mb-1 text-lg font-medium">Organization defaults</h2>
					<p className="mb-3 text-xs text-muted-foreground">
						Applied to members who have not set their own. Owners and admins can
						change them.
					</p>
					<Form method="post" className="flex flex-col gap-4">
						<input type="hidden" name="intent" value="updateOrgPreferences" />
						<PreferencesForm
							groups={settings.organizationPreferences}
							busy={busy}
						/>
						{canEditOrgPreferences ? (
							<button
								type="submit"
								disabled={busy}
								className="h-9 w-fit cursor-pointer rounded-md border border-border bg-transparent px-4 text-sm font-medium hover:bg-muted"
							>
								Save organization defaults
							</button>
						) : null}
					</Form>
				</section>
			) : null}

			{/* Org settings */}
			<section className="mt-8 border-t border-border pt-6">
				<h2 className="mb-3 text-lg font-medium">Organization</h2>
				<p className="text-sm text-muted-foreground">
					Roles, invitations, and ownership transfer live on the{' '}
					<a
						href="/team"
						className="text-foreground underline underline-offset-2"
					>
						team settings
					</a>{' '}
					page.
				</p>
			</section>

			{/* Your data (issue #59: GDPR export/erasure) */}
			<section className="mt-8 border-t border-border pt-6">
				<h2 className="mb-3 text-lg font-medium">Your data</h2>
				<p className="mb-3 text-sm text-muted-foreground">
					Download every row this account owns, plus your account, session,
					preference, and consent history, as a single JSON file.
				</p>
				<a
					href="/settings/export-data"
					className="inline-flex h-9 w-fit items-center rounded-md border border-border bg-transparent px-4 text-sm font-medium no-underline hover:bg-muted"
				>
					Export my data
				</a>
			</section>

			{/* Danger zone */}
			<section className="mt-10 border-t border-destructive/30 pt-6">
				<h2 className="mb-3 text-lg font-medium text-destructive">
					Danger zone
				</h2>
				<p className="mb-3 text-sm text-muted-foreground">
					Deleting your account erases the data you own (comments, etc. — see{' '}
					<a
						href="/settings/export-data"
						className="underline underline-offset-2"
					>
						export
					</a>{' '}
					first if you want a copy) and removes your login. This cannot be
					undone.
				</p>
				<Form method="post" className="flex flex-col gap-2">
					<input type="hidden" name="intent" value="deleteAccount" />
					<label className="flex flex-col gap-1">
						<span className="text-xs text-muted-foreground">Password</span>
						<input
							name="password"
							type="password"
							required
							disabled={busy || !settings.hasSession}
							className="h-9 rounded-md border border-border bg-transparent px-3 text-sm"
						/>
					</label>
					<label className="flex flex-col gap-1">
						<span className="text-xs text-muted-foreground">
							Type DELETE to confirm
						</span>
						<input
							name="confirmation"
							type="text"
							required
							placeholder="DELETE"
							disabled={busy || !settings.hasSession}
							className="h-9 rounded-md border border-border bg-transparent px-3 text-sm"
						/>
					</label>
					<Button
						type="submit"
						variant="destructive"
						disabled={busy || !settings.hasSession}
						className="w-fit"
					>
						Delete account
					</Button>
				</Form>
			</section>
		</main>
	)
}
