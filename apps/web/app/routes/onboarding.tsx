/**
 * First-run setup wizard (task 63 "Onboarding & demo mode").
 *
 * A three-step, owned-code stepper — welcome/workspace → invite teammates
 * (optional) → load demo data — over three existing primitives: the task-52
 * `MemberService` (workspace + invites) and the generic demo-data seeder
 * (`@maxstack/features/demo-mode`). This is a plain stepper, not
 * `DynamicForm`'s `wizard` mode (`packages/ui/src/DynamicForm.tsx`): that
 * primitive drives per-step *field validation* for one resource's schema, but
 * this flow's steps are heterogeneous actions (create an org, send invites,
 * trigger a seed job) with no single form schema to validate against — a
 * hand-rolled stepper over three `<Form>`s is the simpler, honest fit.
 *
 * Fresh-install detection (`resolveOnboarding`): the viewer belongs to no
 * organization, or the project has no data yet. Neither is required to use
 * the app — the wizard is guidance, not a gate — so every step can be
 * skipped, and `/admin` (or the project home) always stays reachable.
 */

import { Alert } from '@maxstack/ui'
import { useState } from 'react'
import { data, Form, Link, useActionData, useNavigation } from 'react-router'
import {
	createWorkspace,
	inviteTeammate,
	loadDemoData,
	resolveOnboarding,
} from '~/onboarding.server'
import type { Route } from './+types/onboarding'

export async function loader({ request }: Route.LoaderArgs) {
	const state = await resolveOnboarding(request)
	if (!state) {
		throw data({ error: 'Sign in to set up your workspace.' }, { status: 401 })
	}
	return state
}

export async function action({ request }: Route.ActionArgs) {
	const state = await resolveOnboarding(request)
	if (!state) return data({ error: 'Not signed in.' }, { status: 401 })
	const form = await request.formData()
	const intent = String(form.get('intent') ?? '')

	try {
		switch (intent) {
			case 'createWorkspace': {
				const name = String(form.get('name') ?? '').trim()
				if (!name)
					return data({ error: 'Workspace name is required.' }, { status: 400 })
				const org = await createWorkspace(request, name)
				return { ok: true as const, org }
			}
			case 'invite': {
				const orgId = String(form.get('orgId') ?? '')
				const email = String(form.get('email') ?? '').trim()
				if (!orgId)
					return data({ error: 'Create a workspace first.' }, { status: 400 })
				if (!email)
					return data({ error: 'Email is required.' }, { status: 400 })
				await inviteTeammate(orgId, email, state.user.id)
				return { ok: true as const, invited: email }
			}
			case 'loadDemoData': {
				const result = await loadDemoData()
				return { ok: true as const, ...result }
			}
			default:
				return data({ error: `Unknown intent: ${intent}` }, { status: 400 })
		}
	} catch (err) {
		return data({ error: (err as Error).message }, { status: 400 })
	}
}

type Step = 'workspace' | 'invite' | 'demo-data' | 'done'

export default function Onboarding({ loaderData }: Route.ComponentProps) {
	const state = loaderData
	const actionData = useActionData<typeof action>()
	const navigation = useNavigation()
	const busy = navigation.state === 'submitting'

	const [step, setStep] = useState<Step>(
		state.needsWorkspace ? 'workspace' : 'invite',
	)
	// The org id the wizard is working with — either just-created, or the
	// viewer's first existing org.
	const orgId =
		actionData && 'org' in actionData && actionData.org
			? actionData.org.id
			: state.orgs[0]?.id

	const steps: { key: Step; label: string }[] = [
		{ key: 'workspace', label: 'Workspace' },
		{ key: 'invite', label: 'Invite your team' },
		{ key: 'demo-data', label: 'Load demo data' },
		{ key: 'done', label: 'Done' },
	]

	return (
		<section className="mx-auto max-w-lg py-10">
			<h1 className="mb-1 text-2xl font-semibold">Welcome to maxstack</h1>
			<p className="mb-6 text-sm text-muted-foreground">
				A few quick steps to set up your workspace — every step is optional and
				you can jump straight to{' '}
				<Link to="/admin" className="underline">
					the admin
				</Link>{' '}
				at any time.
			</p>

			<ol className="mb-8 flex gap-4 text-sm">
				{steps.map((s, i) => (
					<li
						key={s.key}
						className={
							s.key === step
								? 'font-semibold text-foreground'
								: 'text-muted-foreground'
						}
					>
						{i + 1}. {s.label}
					</li>
				))}
			</ol>

			{actionData && 'error' in actionData ? (
				<Alert variant="destructive" className="mb-4">
					{actionData.error}
				</Alert>
			) : null}

			{step === 'workspace' ? (
				<div>
					{state.orgs.length > 0 ? (
						<div className="mb-4 rounded-md border border-border p-3 text-sm">
							You already have a workspace:{' '}
							<strong>{state.orgs[0]?.name}</strong>
						</div>
					) : (
						<Form method="post" className="flex flex-col gap-3">
							<input type="hidden" name="intent" value="createWorkspace" />
							<label className="text-sm font-medium" htmlFor="ws-name">
								Workspace name
							</label>
							<input
								id="ws-name"
								name="name"
								required
								placeholder="Acme Inc"
								className="h-9 rounded-md border border-border px-3 text-sm"
							/>
							<button
								type="submit"
								disabled={busy}
								className="h-9 rounded-md bg-primary px-4 text-sm font-medium text-primary-foreground"
							>
								Create workspace
							</button>
						</Form>
					)}
					<button
						type="button"
						className="mt-4 text-sm underline"
						onClick={() => setStep('invite')}
					>
						Continue →
					</button>
				</div>
			) : null}

			{step === 'invite' ? (
				<div>
					<Form method="post" className="flex flex-col gap-3">
						<input type="hidden" name="intent" value="invite" />
						<input type="hidden" name="orgId" value={orgId ?? ''} />
						<label className="text-sm font-medium" htmlFor="invite-email">
							Teammate email (optional)
						</label>
						<input
							id="invite-email"
							name="email"
							type="email"
							placeholder="teammate@example.com"
							className="h-9 rounded-md border border-border px-3 text-sm"
						/>
						<button
							type="submit"
							disabled={busy || !orgId}
							className="h-9 rounded-md bg-primary px-4 text-sm font-medium text-primary-foreground"
						>
							Send invite
						</button>
					</Form>
					{actionData && 'invited' in actionData ? (
						<p className="mt-2 text-sm text-muted-foreground">
							Invited {actionData.invited}. Manage invites anytime on{' '}
							<Link to="/team" className="underline">
								/team
							</Link>
							.
						</p>
					) : null}
					<button
						type="button"
						className="mt-4 text-sm underline"
						onClick={() => setStep('demo-data')}
					>
						Skip / Continue →
					</button>
				</div>
			) : null}

			{step === 'demo-data' ? (
				<div>
					{state.hasData &&
					!(
						actionData &&
						'resources' in actionData &&
						actionData.resources.length > 0
					) ? (
						<p className="mb-3 text-sm text-muted-foreground">
							This project already has data — demo mode is optional.
						</p>
					) : (
						<p className="mb-3 text-sm text-muted-foreground">
							Load a handful of sample rows for every resource so there's
							something to explore right away. Safe to run more than once — a
							resource that already has rows is left alone.
						</p>
					)}
					<Form method="post">
						<input type="hidden" name="intent" value="loadDemoData" />
						<button
							type="submit"
							disabled={busy}
							className="h-9 rounded-md bg-primary px-4 text-sm font-medium text-primary-foreground"
						>
							Load demo data
						</button>
					</Form>
					{actionData && 'resources' in actionData ? (
						<p className="mt-2 text-sm text-muted-foreground">
							{actionData.resources.length > 0
								? `Seeded: ${actionData.resources.join(', ')}.`
								: actionData.seeded
									? 'Bundle sample data loaded.'
									: 'Everything already had data — nothing to seed.'}
						</p>
					) : null}
					<button
						type="button"
						className="mt-4 text-sm underline"
						onClick={() => setStep('done')}
					>
						Continue →
					</button>
				</div>
			) : null}

			{step === 'done' ? (
				<div>
					<p className="mb-4 text-sm text-muted-foreground">
						You're set up. Head to the admin to explore your data.
					</p>
					<Link
						to="/admin"
						className="inline-flex h-9 items-center rounded-md bg-primary px-4 text-sm font-medium text-primary-foreground no-underline"
					>
						Go to admin
					</Link>
				</div>
			) : null}
		</section>
	)
}
