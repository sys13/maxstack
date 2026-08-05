/**
 * Billing & usage — an owned-code account-settings page (Bar-2) over the billing
 * feature (task 53). It surfaces everything the feature exposes as tailored UI:
 *
 *   - **Plan & trial state** — the current plan, status, and (on a Stripe trial)
 *     when the trial ends, read from the `subscription` mirror.
 *   - **Usage metering** — a live meter per dimension (used / allowance) with a
 *     "record usage" action that runs the plan's quota check; hitting the cap
 *     raises `QuotaError`, which this route turns into a 402 + an inline **quota
 *     wall** that prompts an upgrade.
 *   - **Pricing** — a card per plan with a hosted-checkout button; subscribing
 *     drives the buy adapter and (in demo mode) mirrors the resulting subscription
 *     so the plan state and lifted quota are immediately visible — the page's exit
 *     criterion.
 *   - **Manage billing** — a customer-portal link (the Stripe-hosted surface for
 *     invoices / cancellation) and a reset for the demo.
 *
 * The feature owns the model (plans, entitlements, the Stripe adapter, the metering
 * primitive); `billing.server.ts` binds it to the app's backend. This route maps
 * its typed failure (`QuotaError`) to a flash/wall and revalidates on success.
 */

import { METERS, QuotaError } from '@maxstack/features/billing'
import {
	Alert,
	AlertTitle,
	EntitlementProvider,
	IfEntitled,
	IfFlag,
	Timestamp,
} from '@maxstack/ui'
import {
	data,
	Form,
	redirect,
	useActionData,
	useNavigation,
} from 'react-router'
import {
	openPortal,
	recordUsage,
	resetBilling,
	resolveBilling,
	resolveBillingSubject,
	startCheckout,
} from '~/billing.server'
import type { Route } from './+types/billing'

export async function loader({ request }: Route.LoaderArgs) {
	const view = await resolveBilling(request)
	if (!view) {
		throw data({ error: 'Sign in to manage billing.' }, { status: 401 })
	}
	return view
}

export async function action({ request }: Route.ActionArgs) {
	const resolved = await resolveBillingSubject(request)
	if (!resolved) return data({ error: 'Not signed in.' }, { status: 401 })
	const { subject } = resolved
	const form = await request.formData()
	const intent = String(form.get('intent') ?? '')

	switch (intent) {
		case 'checkout': {
			const plan = String(form.get('plan') ?? '')
			if (!plan) return data({ error: 'No plan selected.' }, { status: 400 })
			const { url, appliedLocally } = await startCheckout(
				request,
				subject,
				plan,
			)
			// Live Stripe: hand the browser to the hosted checkout. Demo: the mirror
			// is already applied, so revalidate to show the new plan/trial state.
			if (!appliedLocally) return redirect(url)
			return redirect('/billing?checkout=success')
		}
		case 'portal': {
			const { url } = await openPortal(request, subject)
			// Live Stripe: redirect to the hosted portal. Demo: the URL is a stand-in
			// (no live portal to open), so surface it rather than a dead redirect.
			const live = url.startsWith('https://billing.stripe.com')
			if (live) return redirect(url)
			return data({ notice: `Customer portal session created: ${url}` })
		}
		case 'use': {
			const meter = String(form.get('meter') ?? 'api-calls')
			const quantity = Number(form.get('quantity') ?? '1') || 1
			try {
				await recordUsage(subject, meter, quantity)
			} catch (err) {
				if (err instanceof QuotaError) {
					return data(
						{
							wall: {
								meter: err.meter,
								limit: err.limit,
								used: err.used,
							},
						},
						{ status: 402 },
					)
				}
				throw err
			}
			return redirect('/billing')
		}
		case 'reset': {
			await resetBilling(subject)
			return redirect('/billing')
		}
		default:
			return data({ error: `Unknown action: ${intent}` }, { status: 400 })
	}
}

/** Date alone, hydration-safe. `precision` picks the deterministic
 *  and the local rendering together, so there is no datetime→date flicker. */
const StampDate = ({ iso }: { iso: string }) => (
	<Timestamp iso={iso} precision="date" />
)

export default function Billing({ loaderData }: Route.ComponentProps) {
	const view = loaderData
	const actionData = useActionData<typeof action>()
	const nav = useNavigation()
	const busy = nav.state !== 'idle'
	const error = actionData && 'error' in actionData ? actionData.error : null
	const notice = actionData && 'notice' in actionData ? actionData.notice : null
	const wall = actionData && 'wall' in actionData ? actionData.wall : null
	const entitlements = view.plans.find((p) => p.isCurrent)?.entitlements ?? []

	return (
		<EntitlementProvider entitlements={entitlements} flags={view.flags}>
			<main className="mx-auto max-w-3xl px-6 py-10">
				<h1 className="text-2xl font-semibold">Billing &amp; usage</h1>
				<p className="mt-1 text-sm text-muted-foreground">
					You are on the{' '}
					<span className="font-medium text-foreground">
						{view.plan.planName}
					</span>{' '}
					plan
					{view.plan.hasSubscription ? (
						<> · {view.plan.status}</>
					) : (
						<> · no active subscription</>
					)}
					{view.liveStripe ? null : (
						<span className="ml-2 rounded bg-muted px-1.5 py-0.5 text-xs text-muted-foreground">
							demo mode · no live Stripe
						</span>
					)}
				</p>

				{/* Trial banner */}
				{view.plan.trialing && view.plan.currentPeriodEnd ? (
					<p className="mt-4 rounded-md border border-primary/40 bg-primary/10 px-3 py-2 text-sm">
						Your {view.plan.planName} trial ends{' '}
						<span className="font-medium">
							<StampDate iso={view.plan.currentPeriodEnd} />
						</span>
						. Manage or cancel any time from the customer portal below.
					</p>
				) : null}

				{error ? (
					<Alert variant="destructive" role="alert" className="mt-4">
						{error}
					</Alert>
				) : null}
				{notice ? (
					<p className="mt-4 break-all rounded-md border border-border bg-muted/40 px-3 py-2 text-sm">
						{notice}
					</p>
				) : null}

				{/* Usage meters */}
				<section className="mt-8">
					<h2 className="mb-3 text-lg font-medium">Usage this period</h2>
					<ul className="space-y-4">
						{view.meters.map((m) => {
							const meter = METERS[m.meter]
							const pct =
								m.unlimited || m.limit === null || m.limit === 0
									? m.unlimited
										? 0
										: 100
									: Math.min(100, Math.round((m.used / m.limit) * 100))
							return (
								<li
									key={m.meter}
									className="rounded-md border border-border px-4 py-3"
								>
									<div className="flex items-baseline justify-between">
										<span className="text-sm font-medium">
											{meter?.name ?? m.meter}
										</span>
										<span className="text-sm text-muted-foreground">
											{m.used.toLocaleString()}
											{m.unlimited
												? ' used · unlimited'
												: ` / ${m.limit?.toLocaleString()} ${meter?.unit ?? ''}`}
										</span>
									</div>
									{m.unlimited ? (
										<p className="mt-2 text-xs text-muted-foreground">
											Unlimited on the {view.plan.planName} plan.
										</p>
									) : (
										<div className="mt-2 h-2 w-full overflow-hidden rounded-full bg-muted">
											<div
												className={`h-full rounded-full ${
													m.exceeded ? 'bg-destructive' : 'bg-primary'
												}`}
												style={{ width: `${pct}%` }}
											/>
										</div>
									)}
									<div className="mt-3 flex flex-wrap items-center gap-2">
										<Form method="post">
											<input type="hidden" name="intent" value="use" />
											<input type="hidden" name="meter" value={m.meter} />
											<input type="hidden" name="quantity" value="1" />
											<button
												type="submit"
												disabled={busy}
												className="h-8 cursor-pointer rounded-md border border-border bg-transparent px-3 text-xs hover:text-foreground"
											>
												Record 1
											</button>
										</Form>
										<Form method="post">
											<input type="hidden" name="intent" value="use" />
											<input type="hidden" name="meter" value={m.meter} />
											<input type="hidden" name="quantity" value="25" />
											<button
												type="submit"
												disabled={busy}
												className="h-8 cursor-pointer rounded-md border border-border bg-transparent px-3 text-xs hover:text-foreground"
											>
												Record 25 {meter?.unit ?? 'units'}
											</button>
										</Form>
										{!m.unlimited && m.remaining !== null ? (
											<span className="text-xs text-muted-foreground">
												{m.remaining.toLocaleString()} remaining
											</span>
										) : null}
									</div>
								</li>
							)
						})}
					</ul>
				</section>

				{/* Quota wall — shown when a record hit the plan's cap.

				    The body text is pulled back to `foreground`: the destructive
				    variant colours its whole container, which is right for a
				    one-line error and too much for a paragraph the reader has to
				    actually read. The heading carries the alarm. */}
				{wall ? (
					<Alert variant="destructive" className="mt-6 p-4">
						<AlertTitle className="text-sm font-semibold">
							Quota reached
						</AlertTitle>
						<p className="mt-1 text-sm text-foreground">
							You’ve used {wall.used?.toLocaleString()} of your{' '}
							{wall.limit?.toLocaleString()}{' '}
							{METERS[wall.meter]?.name ?? wall.meter} allowance on the{' '}
							{view.plan.planName} plan. Upgrade to keep going.
						</p>
						<Form method="post" className="mt-3">
							<input type="hidden" name="intent" value="checkout" />
							<input type="hidden" name="plan" value="pro" />
							<button
								type="submit"
								disabled={busy}
								className="h-9 cursor-pointer rounded-md bg-primary px-4 text-sm font-medium text-primary-foreground hover:opacity-90"
							>
								Upgrade to Pro
							</button>
						</Form>
					</Alert>
				) : null}

				{/* Pricing */}
				<section className="mt-10">
					<h2 className="mb-3 text-lg font-medium">Plans</h2>
					<div className="grid gap-4 sm:grid-cols-3">
						{view.plans.map((p) => (
							<div
								key={p.id}
								className={`flex flex-col rounded-lg border p-4 ${
									p.isCurrent
										? 'border-primary ring-1 ring-primary'
										: 'border-border'
								}`}
							>
								<div className="flex items-baseline justify-between">
									<span className="font-medium">{p.name}</span>
									{p.isCurrent ? (
										<span className="rounded bg-primary/15 px-1.5 py-0.5 text-xs font-medium text-primary">
											Current
										</span>
									) : null}
								</div>
								<p className="mt-1 text-2xl font-semibold">
									${p.priceMonthly}
									<span className="text-sm font-normal text-muted-foreground">
										/mo
									</span>
								</p>
								<ul className="mt-3 flex-1 space-y-1 text-xs text-muted-foreground">
									<li>
										{p.limits['api-calls'] === undefined
											? 'Unlimited API calls'
											: `${p.limits['api-calls'].toLocaleString()} API calls / mo`}
									</li>
									{p.entitlements.map((e) => (
										<li key={e}>· {e}</li>
									))}
									{p.entitlements.length === 0 ? (
										<li>· core features</li>
									) : null}
								</ul>
								<div className="mt-4">
									{p.isCurrent ? (
										<button
											type="button"
											disabled
											className="h-9 w-full cursor-default rounded-md border border-border bg-transparent px-4 text-sm text-muted-foreground"
										>
											Current plan
										</button>
									) : p.id === 'free' ? (
										view.plan.hasSubscription ? (
											<Form method="post">
												<input type="hidden" name="intent" value="reset" />
												<button
													type="submit"
													disabled={busy}
													className="h-9 w-full cursor-pointer rounded-md border border-border bg-transparent px-4 text-sm hover:text-foreground"
												>
													Downgrade to Free
												</button>
											</Form>
										) : (
											<button
												type="button"
												disabled
												className="h-9 w-full cursor-default rounded-md border border-border bg-transparent px-4 text-sm text-muted-foreground"
											>
												Default plan
											</button>
										)
									) : (
										<Form method="post">
											<input type="hidden" name="intent" value="checkout" />
											<input type="hidden" name="plan" value={p.id} />
											<button
												type="submit"
												disabled={busy}
												className="h-9 w-full cursor-pointer rounded-md bg-primary px-4 text-sm font-medium text-primary-foreground hover:opacity-90"
											>
												{view.plan.hasSubscription
													? `Switch to ${p.name}`
													: `Subscribe to ${p.name}`}
											</button>
										</Form>
									)}
								</div>
							</div>
						))}
					</div>
				</section>

				{/* Manage billing */}
				<section className="mt-10 flex flex-wrap items-center gap-3 border-t border-border pt-6">
					<Form method="post">
						<input type="hidden" name="intent" value="portal" />
						<button
							type="submit"
							disabled={busy || !view.plan.hasSubscription}
							title={
								view.plan.hasSubscription
									? 'Open the Stripe customer portal'
									: 'Subscribe first to manage billing'
							}
							className="h-9 cursor-pointer rounded-md border border-border bg-transparent px-4 text-sm font-medium hover:text-foreground disabled:cursor-not-allowed disabled:opacity-50"
						>
							Open customer portal
						</button>
					</Form>
					<Form method="post">
						<input type="hidden" name="intent" value="reset" />
						<button
							type="submit"
							disabled={busy}
							className="h-9 cursor-pointer rounded-md border border-border bg-transparent px-4 text-sm text-muted-foreground hover:text-foreground"
						>
							Reset demo
						</button>
					</Form>
					{/* Pro-only + flagged: hidden on Free, and hidden while `usage-csv-export`
				    is off (task 54's exit criterion — composes <IfEntitled> + <IfFlag>). */}
					<IfEntitled feature="analytics">
						<IfFlag flag="usage-csv-export">
							<a
								href="/billing/export-csv"
								className="inline-flex h-9 cursor-pointer items-center rounded-md border border-border bg-transparent px-4 text-sm text-muted-foreground hover:text-foreground"
							>
								Export usage CSV
							</a>
						</IfFlag>
					</IfEntitled>
				</section>
			</main>
		</EntitlementProvider>
	)
}
