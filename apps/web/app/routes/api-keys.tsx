/**
 * API keys — an owned-code page (Bar-2) over `ApiKeyService` (task 57). Issue
 * a key scoped to one resource + a set of actions, revoke or rotate it, and
 * call the REST API with it. Scope is enforced at the route layer
 * (`checkApiKeyScope` in `sprout.server.ts`) — a key can only do what its
 * scope grants for that one resource, on top of (never wider than) the
 * resource's own normal access rule.
 *
 * The plaintext key is shown exactly once, right after issue/rotate — only
 * its hash is ever persisted, so this page is the only place it's visible.
 */

import { Alert, Timestamp } from '@maxstack/ui'
import { data, Form, useActionData, useNavigation } from 'react-router'
import { getApiKeyService, resolveApiKeys } from '~/api-keys.server'
import type { Route } from './+types/api-keys'

const ACTIONS = ['read', 'create', 'update', 'delete'] as const

export async function loader({ request }: Route.LoaderArgs) {
	const view = await resolveApiKeys(request)
	if (!view) {
		throw data({ error: 'Sign in to manage API keys.' }, { status: 401 })
	}
	return view
}

export async function action({ request }: Route.ActionArgs) {
	const view = await resolveApiKeys(request)
	if (!view) return data({ error: 'Not signed in.' }, { status: 401 })
	const service = await getApiKeyService()
	const form = await request.formData()
	const intent = String(form.get('intent') ?? '')

	switch (intent) {
		case 'issue': {
			const name = String(form.get('name') ?? '').trim()
			const resource = String(form.get('resource') ?? '')
			const actions = ACTIONS.filter((a) => form.get(a) === 'on')
			if (!name) return data({ error: 'Name is required.' }, { status: 400 })
			if (!resource || actions.length === 0) {
				return data(
					{ error: 'Pick a resource and at least one action.' },
					{ status: 400 },
				)
			}
			const budget = Number.parseInt(String(form.get('rateLimit') ?? ''), 10)
			try {
				const issued = await service.issueKey({
					userId: view.userId,
					name,
					scope: { [resource]: actions },
					// Pinned to the issuer's *current* org, not to a field the form
					// offers: a picker here would let someone mint a key for an org they
					// are looking at rather than one they are in. Null when the project
					// has no orgs, in which case the key reaches no tenant-scoped
					// resource — which is the correct answer, not a limitation.
					organizationId: view.orgId ?? null,
					rateLimitPerMinute:
						Number.isFinite(budget) && budget > 0 ? budget : null,
				})
				return data({ issued })
			} catch (err) {
				// `issueKey` refuses a malformed or empty scope by throwing; its message
				// names the problem, so surface it rather than a generic failure.
				return data(
					{
						error: err instanceof Error ? err.message : 'Could not issue key.',
					},
					{ status: 400 },
				)
			}
		}
		case 'revoke': {
			await service.revokeKey(String(form.get('id') ?? ''), view.userId)
			return data({ ok: true })
		}
		case 'rotate': {
			const issued = await service.rotateKey(
				String(form.get('id') ?? ''),
				view.userId,
			)
			return data({ issued })
		}
		default:
			return data({ error: `Unknown action: ${intent}` }, { status: 400 })
	}
}

/** A nullable instant. `<Timestamp>` server-renders a runtime-independent string
 * and upgrades to the viewer's locale after mount. */
const Stamp = ({ iso }: { iso: Date | string | null }) =>
	iso ? <Timestamp iso={new Date(iso).toISOString()} /> : <>—</>

export default function ApiKeys({ loaderData }: Route.ComponentProps) {
	const view = loaderData
	const actionData = useActionData<typeof action>()
	const nav = useNavigation()
	const busy = nav.state !== 'idle'
	const error = actionData && 'error' in actionData ? actionData.error : null
	const issued = actionData && 'issued' in actionData ? actionData.issued : null

	return (
		<main className="mx-auto max-w-2xl px-6 py-10">
			<h1 className="text-2xl font-semibold">API keys</h1>
			<p className="mt-1 text-sm text-muted-foreground">
				Programmatic access to the REST API — see{' '}
				<a href="/api-docs" className="underline underline-offset-2">
					API docs
				</a>
				.
			</p>

			{error ? (
				<Alert variant="destructive" role="alert" className="mt-4">
					{error}
				</Alert>
			) : null}

			{issued ? (
				<div className="mt-4 rounded-md border border-primary/40 bg-primary/10 px-3 py-3 text-sm">
					<p className="font-medium">
						Copy this key now — it won't be shown again.
					</p>
					<code className="mt-2 block break-all rounded bg-background px-2 py-1 text-xs">
						{issued.key}
					</code>
				</div>
			) : null}

			<section className="mt-8">
				<h2 className="mb-3 text-lg font-medium">Issue a key</h2>
				<Form method="post" className="flex flex-col gap-3">
					<input type="hidden" name="intent" value="issue" />
					<label className="flex flex-col gap-1">
						<span className="text-xs text-muted-foreground">Name</span>
						<input
							name="name"
							type="text"
							required
							placeholder="e.g. CI pipeline"
							disabled={busy}
							className="h-9 rounded-md border border-border bg-transparent px-3 text-sm"
						/>
					</label>
					<label className="flex flex-col gap-1">
						<span className="text-xs text-muted-foreground">Resource</span>
						<select
							name="resource"
							required
							disabled={busy}
							className="h-9 rounded-md border border-border bg-transparent px-3 text-sm"
						>
							{view.resources.map((r) => (
								<option key={r} value={r}>
									{r}
								</option>
							))}
						</select>
					</label>
					<div className="flex flex-wrap gap-3">
						{ACTIONS.map((a) => (
							<label key={a} className="flex items-center gap-2 text-sm">
								<input type="checkbox" name={a} disabled={busy} />
								{a}
							</label>
						))}
					</div>
					<label className="flex flex-col gap-1">
						<span className="text-xs text-muted-foreground">
							Requests per minute (optional — blank uses the deployment default)
						</span>
						<input
							name="rateLimit"
							type="number"
							min="1"
							step="1"
							placeholder="e.g. 30"
							disabled={busy}
							className="h-9 w-40 rounded-md border border-border bg-transparent px-3 text-sm"
						/>
					</label>
					{view.orgId ? (
						<p className="text-xs text-muted-foreground">
							This key will be pinned to your active organization (
							<code>{view.orgId}</code>) and can only reach that org's rows.
						</p>
					) : null}
					<button
						type="submit"
						disabled={busy}
						className="h-9 w-fit cursor-pointer rounded-md bg-primary px-4 text-sm font-medium text-primary-foreground hover:opacity-90"
					>
						Issue key
					</button>
				</Form>
			</section>

			<section className="mt-8 border-t border-border pt-6">
				<h2 className="mb-3 text-lg font-medium">Your keys</h2>
				{view.keys.length === 0 ? (
					<p className="text-sm text-muted-foreground">No keys yet.</p>
				) : (
					<ul className="divide-y divide-border rounded-md border border-border">
						{view.keys.map((k) => (
							<li
								key={k.id}
								className="flex flex-wrap items-center gap-3 px-4 py-3"
							>
								<span className="min-w-0 flex-1">
									<span className="text-sm font-medium">{k.name}</span>
									{k.revokedAt ? (
										<span className="ml-2 rounded bg-muted px-1.5 py-0.5 text-xs text-muted-foreground">
											revoked
										</span>
									) : null}
									<div className="text-xs text-muted-foreground">
										<code>{k.prefix}…</code> ·{' '}
										{Object.entries(k.scope)
											.map(([r, actions]) => `${r}: ${actions.join(', ')}`)
											.join('; ')}
									</div>
									<div className="text-xs text-muted-foreground">
										Created <Stamp iso={k.createdAt} /> · Last used{' '}
										<Stamp iso={k.lastUsedAt} />
										{k.organizationId ? ` · org ${k.organizationId}` : null}
										{k.rateLimitPerMinute
											? ` · ${k.rateLimitPerMinute}/min`
											: null}
									</div>
								</span>
								{!k.revokedAt ? (
									<div className="flex gap-2">
										<Form method="post">
											<input type="hidden" name="intent" value="rotate" />
											<input type="hidden" name="id" value={k.id} />
											<button
												type="submit"
												disabled={busy}
												className="h-8 cursor-pointer rounded-md border border-border bg-transparent px-2 text-xs text-muted-foreground hover:text-foreground"
											>
												Rotate
											</button>
										</Form>
										<Form method="post">
											<input type="hidden" name="intent" value="revoke" />
											<input type="hidden" name="id" value={k.id} />
											<button
												type="submit"
												disabled={busy}
												className="h-8 cursor-pointer rounded-md border border-destructive/50 bg-transparent px-2 text-xs text-destructive hover:bg-destructive/10"
											>
												Revoke
											</button>
										</Form>
									</div>
								) : null}
							</li>
						))}
					</ul>
				)}
			</section>
		</main>
	)
}
