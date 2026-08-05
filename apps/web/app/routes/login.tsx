/**
 * Sign in / sign up — the user-facing auth surface.
 *
 * With the auth bundle installed, `/api/auth/*` (better-auth) is live but there
 * was no page a person could reach to actually sign in: `/login` 404'd and the
 * settings page just said "sign in" with nowhere to go. This owned-code route
 * closes that hole. It talks to better-auth's *server* API directly (no client
 * auth SDK): the `action` calls `auth.api.signInEmail` / `signUpEmail` /
 * `signOut` with `returnHeaders: true`, then forwards the `Set-Cookie` header(s)
 * better-auth minted onto a redirect — the same session cookie `/api/auth/*`
 * would have set, just driven from a plain server action + `<Form>`.
 *
 * The `loader` sends an already-signed-in visitor away (checking for a *real*
 * session, not `resolveUser`'s dev-admin fallback). The dev seed owner
 * (`admin@maxstack.dev` / `maxstack`, seeded by `sprout.server.ts`) is hinted on
 * the form so the demo walkthrough signs in on the first try.
 */

import { Alert } from '@maxstack/ui'
import {
	data,
	Form,
	redirect,
	useActionData,
	useNavigation,
} from 'react-router'
import { getAuth } from '~/sprout.server'
import type { Route } from './+types/login'

/** Copy every `Set-Cookie` better-auth minted onto a redirect to `to`, so the
 * new session cookie rides home with the navigation. `getSetCookie()` keeps the
 * cookies split (a single `.get('set-cookie')` would comma-join and mangle them). */
function redirectWithSession(from: Headers, to: string): Response {
	const headers = new Headers()
	for (const cookie of from.getSetCookie()) headers.append('set-cookie', cookie)
	return redirect(to, { headers })
}

export async function loader({ request }: Route.LoaderArgs) {
	const auth = await getAuth()
	// A *real* session only — `resolveUser` would hand back the dev-admin
	// fallback for an anonymous visitor and bounce everyone off the sign-in page.
	const session = await auth.api.getSession({ headers: request.headers })
	if (session?.user) throw redirect('/')
	return null
}

export async function action({ request }: Route.ActionArgs) {
	const auth = await getAuth()
	const form = await request.formData()
	const intent = String(form.get('intent') ?? '')

	try {
		switch (intent) {
			case 'signIn': {
				const email = String(form.get('email') ?? '').trim()
				const password = String(form.get('password') ?? '')
				if (!email || !password) {
					return data(
						{ error: 'Email and password are required.' },
						{ status: 400 },
					)
				}
				const res = await auth.api.signInEmail({
					body: { email, password },
					returnHeaders: true,
				})
				return redirectWithSession(res.headers, '/')
			}
			case 'signUp': {
				const name = String(form.get('name') ?? '').trim()
				const email = String(form.get('email') ?? '').trim()
				const password = String(form.get('password') ?? '')
				if (!name || !email || !password) {
					return data(
						{ error: 'Name, email, and password are all required.' },
						{ status: 400 },
					)
				}
				const res = await auth.api.signUpEmail({
					body: { name, email, password },
					returnHeaders: true,
				})
				return redirectWithSession(res.headers, '/')
			}
			case 'signOut': {
				const res = await auth.api.signOut({
					headers: request.headers,
					returnHeaders: true,
				})
				// Forwards the *cleared* session cookie the same way sign-in forwards
				// the new one — the settings/nav "Sign out" control posts here.
				return redirectWithSession(res.headers, '/login')
			}
			default:
				return data({ error: `Unknown action: ${intent}` }, { status: 400 })
		}
	} catch (err) {
		// better-auth throws `APIError` on bad credentials / duplicate email — its
		// message is user-facing enough to surface directly.
		const message = err instanceof Error ? err.message : 'Something went wrong.'
		return data({ error: message }, { status: 401 })
	}
}

export default function Login() {
	const actionData = useActionData<typeof action>()
	const nav = useNavigation()
	const busy = nav.state !== 'idle'

	return (
		<main className="mx-auto max-w-sm px-6 py-12">
			<h1 className="text-2xl font-semibold">Sign in</h1>
			<p className="mt-1 text-sm text-muted-foreground">
				Sign in to your account, or create a new one below.
			</p>

			{actionData?.error ? (
				<Alert variant="destructive" role="alert" className="mt-4">
					{actionData.error}
				</Alert>
			) : null}

			{/* Sign in */}
			<Form method="post" className="mt-6 flex flex-col gap-2">
				<input type="hidden" name="intent" value="signIn" />
				<label className="flex flex-col gap-1">
					<span className="text-xs text-muted-foreground">Email</span>
					<input
						name="email"
						type="email"
						required
						autoComplete="email"
						disabled={busy}
						className="h-9 rounded-md border border-border bg-transparent px-3 text-sm"
					/>
				</label>
				<label className="flex flex-col gap-1">
					<span className="text-xs text-muted-foreground">Password</span>
					<input
						name="password"
						type="password"
						required
						autoComplete="current-password"
						disabled={busy}
						className="h-9 rounded-md border border-border bg-transparent px-3 text-sm"
					/>
				</label>
				<button
					type="submit"
					disabled={busy}
					className="mt-1 h-9 cursor-pointer rounded-md bg-primary px-4 text-sm font-medium text-primary-foreground hover:opacity-90 disabled:opacity-50"
				>
					Sign in
				</button>
			</Form>

			<p className="mt-2 text-xs text-muted-foreground">
				Dev seed owner: <code>admin@maxstack.dev</code> / <code>maxstack</code>.
			</p>

			{/* Sign up */}
			<section className="mt-8 border-t border-border pt-6">
				<h2 className="mb-3 text-lg font-medium">Create an account</h2>
				<Form method="post" className="flex flex-col gap-2">
					<input type="hidden" name="intent" value="signUp" />
					<label className="flex flex-col gap-1">
						<span className="text-xs text-muted-foreground">Name</span>
						<input
							name="name"
							type="text"
							required
							autoComplete="name"
							disabled={busy}
							className="h-9 rounded-md border border-border bg-transparent px-3 text-sm"
						/>
					</label>
					<label className="flex flex-col gap-1">
						<span className="text-xs text-muted-foreground">Email</span>
						<input
							name="email"
							type="email"
							required
							autoComplete="email"
							disabled={busy}
							className="h-9 rounded-md border border-border bg-transparent px-3 text-sm"
						/>
					</label>
					<label className="flex flex-col gap-1">
						<span className="text-xs text-muted-foreground">Password</span>
						<input
							name="password"
							type="password"
							required
							minLength={8}
							autoComplete="new-password"
							disabled={busy}
							className="h-9 rounded-md border border-border bg-transparent px-3 text-sm"
						/>
					</label>
					<button
						type="submit"
						disabled={busy}
						className="mt-1 h-9 w-fit cursor-pointer rounded-md border border-border bg-transparent px-4 text-sm font-medium hover:bg-muted disabled:opacity-50"
					>
						Sign up
					</button>
				</Form>
			</section>
		</main>
	)
}
