/**
 * Jobs — an owned-code page (Bar-2) over `JobQueue` (task 59). The queue
 * itself lives one layer down: `sprout.server.ts`'s `getAuditSink()` enqueues
 * a `webhook.emit` job for every create/update/delete instead of delivering
 * inline (task 58's synchronous fetch moved off the request path), and the
 * same queue's poll worker runs it out of band. This page is the visibility
 * surface the exit criteria asks for — recent jobs + status — plus a form to
 * enqueue the second concrete job type, a server-side bulk CSV export.
 */

import type { JobRecord } from '@maxstack/features/jobs'
import {
	Badge,
	type BadgeVariant,
	Table,
	TableBody,
	TableCell,
	TableHead,
	TableHeader,
	TableRow,
	Timestamp,
} from '@maxstack/ui'
import { data, Form, useNavigation, useRevalidator } from 'react-router'
import {
	enqueueExport,
	resolveJobs,
	retryJob,
	triggerSourceRun,
} from '~/jobs.server'
import type { Route } from './+types/jobs'

export async function loader({ request }: Route.LoaderArgs) {
	const view = await resolveJobs(request)
	if (!view) {
		throw data({ error: 'Sign in to view jobs.' }, { status: 401 })
	}
	return view
}

export async function action({ request }: Route.ActionArgs) {
	const view = await resolveJobs(request)
	if (!view) return data({ error: 'Not signed in.' }, { status: 401 })
	const form = await request.formData()
	const intent = String(form.get('intent') ?? '')

	switch (intent) {
		case 'retry': {
			const id = String(form.get('jobId') ?? '')
			if (!id) return data({ error: 'Which job?' }, { status: 400 })
			await retryJob(id)
			return data({ retried: id })
		}
		case 'export': {
			const resource = String(form.get('resource') ?? '')
			if (!resource) {
				return data({ error: 'Pick a resource to export.' }, { status: 400 })
			}
			const job = await enqueueExport(resource)
			return data({ enqueued: job.id })
		}
		// The `manual` trigger of issue #173, given the surface it never had
		//. It borrows the operator's own identity, so pressing it can do
		// nothing the person pressing it could not do through the UI.
		case 'run-source': {
			const key = String(form.get('sourceKey') ?? '')
			if (!key) return data({ error: 'Which source?' }, { status: 400 })
			const result = await triggerSourceRun(request, key)
			if (!result.ok)
				return data(
					{ error: `Cannot run "${key}": ${result.reason}` },
					{ status: 400 },
				)
			return data({ ran: key })
		}
		default:
			return data({ error: `Unknown action: ${intent}` }, { status: 400 })
	}
}

/** See issue #267: a bare `toLocaleString()` hydrates differently to how it
 *  server-renders on every viewer whose zone is not the server's. */
const Stamp = ({ iso }: { iso: Date | string }) => (
	<Timestamp iso={new Date(iso).toISOString()} />
)

/**
 * `running` takes `primary` rather than a blue: there is no blue in the theme,
 * and the literal `bg-blue-500` this used to carry stayed blue in a forest- or
 * rose-themed app while every neighbouring pill moved. Filled-primary is also
 * the right weight — the running job is the one worth looking at.
 */
const STATUS_VARIANT: Record<JobRecord['status'], BadgeVariant> = {
	pending: 'outline',
	running: 'primary',
	succeeded: 'success',
	failed: 'destructive',
}

/**
 * How each source-health state reads. `stale` is amber rather than red on
 * purpose: "this data is older than it should be" and "this integration is
 * broken" are different facts, and painting both red produces a banner nobody
 * believes.
 */
const SOURCE_STATE_VARIANT: Record<string, BadgeVariant> = {
	'never-run': 'outline',
	ok: 'success',
	stale: 'warning',
	failing: 'destructive',
	paused: 'default',
}

/** A `data:` URI download for an `export.csv` job's result — small demo-scale
 * exports only (the CSV lives in the `job.result` column, not blob storage). */
function downloadHrefFor(job: JobRecord): string | null {
	if (job.type !== 'export.csv' || job.status !== 'succeeded') return null
	const result = job.result as { csv?: string } | null
	if (!result?.csv) return null
	return `data:text/csv;charset=utf-8,${encodeURIComponent(result.csv)}`
}

export default function Jobs({ loaderData }: Route.ComponentProps) {
	const view = loaderData
	const nav = useNavigation()
	const revalidator = useRevalidator()
	const busy = nav.state !== 'idle'

	return (
		<main className="mx-auto max-w-3xl px-6 py-10">
			<h1 className="text-2xl font-semibold">Jobs</h1>
			<p className="mt-1 text-sm text-muted-foreground">
				Declared schedules and the durable runtime behind them. Delivery is{' '}
				<strong>at-least-once</strong>: every occurrence is claimed by a stable
				idempotency key, so a restart cannot double-fire it — but a handler can
				still see the same work twice and must key its writes on that id.
			</p>

			<section className="mt-8">
				<h2 className="mb-3 text-lg font-medium">Declared schedules</h2>
				{view.schedules.length === 0 ? (
					<p className="text-sm text-muted-foreground">
						No schedules declared. `schedules.declare` adds one — a recurrence,
						the timezone it is read in, and the identity its runs carry.
					</p>
				) : (
					<div className="space-y-3">
						{view.schedules.map((schedule) => (
							<div
								key={schedule.key}
								className="rounded-md border border-border p-4"
							>
								<div className="flex flex-wrap items-baseline justify-between gap-2">
									<span className="font-mono text-sm">{schedule.key}</span>
									<Badge variant={schedule.paused ? 'default' : 'success'}>
										{schedule.paused ? 'paused' : 'active'}
									</Badge>
								</div>
								<p className="mt-1 text-sm text-muted-foreground">
									{schedule.description}
								</p>
								<dl className="mt-2 grid gap-x-6 gap-y-1 text-xs text-muted-foreground sm:grid-cols-2">
									<div>
										<dt className="inline font-medium">Runs </dt>
										<dd className="inline">{schedule.recurrence}</dd>
									</div>
									<div>
										<dt className="inline font-medium">As </dt>
										<dd className="inline">{schedule.runAs}</dd>
									</div>
									<div>
										<dt className="inline font-medium">Next </dt>
										<dd className="inline">
											{schedule.nextRunIso ? (
												<Stamp iso={schedule.nextRunIso} />
											) : (
												'never (paused)'
											)}
										</dd>
									</div>
									<div>
										<dt className="inline font-medium">Runs recorded </dt>
										<dd className="inline">{schedule.history.length}</dd>
									</div>
								</dl>
							</div>
						))}
					</div>
				)}
			</section>

			<section className="mt-10">
				<h2 className="mb-3 text-lg font-medium">External data sources</h2>
				{view.sources.length === 0 ? (
					<p className="text-sm text-muted-foreground">
						No sources declared. `sources.declare` adds one — an endpoint, the
						credential it uses <em>by name</em>, and a typed mapping onto entity
						fields. The spec never holds the credential itself.
					</p>
				) : (
					<div className="space-y-3">
						{view.sources.map((source) => (
							<div
								key={source.key}
								className="rounded-md border border-border p-4"
							>
								<div className="flex flex-wrap items-baseline justify-between gap-2">
									<span className="font-mono text-sm">{source.key}</span>
									<Badge variant={SOURCE_STATE_VARIANT[source.health.state]}>
										{source.health.state}
									</Badge>
								</div>
								<p className="mt-1 text-sm text-muted-foreground">
									{source.description}
								</p>
								{/* The degradation surface: a sentence about the DATA, not a
								    stack trace. A source that is down leaves the page intact
								    and says how old what you are looking at is. */}
								<p className="mt-2 text-sm">{source.health.summary}</p>
								{/* Said at declaration time rather than after a night of dead
								    letters: the one combination that cannot land a
								    row is a tenant-scoped entity and a run with no org, and the
								    place to read that is beside the declaration. */}
								{source.blocked && (
									<p className="mt-2 rounded-md border border-destructive/40 bg-destructive/5 p-2 text-sm text-destructive">
										This source cannot write: {source.blocked}.
									</p>
								)}
								{/* The `manual` trigger, given a surface. Only for a
								    source whose declaration sanctions it — the page never invents
								    a trigger the spec withheld. */}
								{source.runnable && (
									<Form method="post" className="mt-2">
										<input type="hidden" name="intent" value="run-source" />
										<input type="hidden" name="sourceKey" value={source.key} />
										<button
											type="submit"
											className="rounded-md border border-border px-2 py-1 text-xs hover:bg-muted"
											disabled={busy}
										>
											Run now
										</button>
									</Form>
								)}
								<dl className="mt-2 grid gap-x-6 gap-y-1 text-xs text-muted-foreground sm:grid-cols-2">
									<div>
										<dt className="inline font-medium">Fetches </dt>
										<dd className="inline">{source.shape}</dd>
									</div>
									<div>
										<dt className="inline font-medium">Auth </dt>
										<dd className="inline">{source.auth}</dd>
									</div>
									<div>
										<dt className="inline font-medium">Last success </dt>
										<dd className="inline">
											{source.health.lastSuccessAt ? (
												<Stamp iso={source.health.lastSuccessAt} />
											) : (
												'never'
											)}
										</dd>
									</div>
									<div>
										<dt className="inline font-medium">Failures in a row </dt>
										<dd className="inline">
											{source.health.consecutiveFailures}
										</dd>
									</div>
								</dl>
							</div>
						))}
					</div>
				)}
			</section>

			<section className="mt-8">
				<h2 className="mb-3 text-lg font-medium">
					Dead letter — needs a human
				</h2>
				{view.deadLettered.length === 0 ? (
					<p className="text-sm text-muted-foreground">
						Nothing has exhausted its retries.
					</p>
				) : (
					<ul className="space-y-2">
						{view.deadLettered.map((job) => (
							<li
								key={job.id}
								className="flex flex-wrap items-center justify-between gap-3 rounded-md border border-destructive/40 p-3 text-sm"
							>
								<div>
									<span className="font-mono text-xs">{job.type}</span>
									{job.scheduleKey ? (
										<span className="ml-2 text-xs text-muted-foreground">
											{job.scheduleKey}
										</span>
									) : null}
									<p className="text-xs text-destructive">{job.error}</p>
								</div>
								<Form method="post">
									<input type="hidden" name="intent" value="retry" />
									<input type="hidden" name="jobId" value={job.id} />
									<button
										type="submit"
										disabled={busy}
										className="h-8 rounded-md border border-border px-3 text-xs"
									>
										Retry once
									</button>
								</Form>
							</li>
						))}
					</ul>
				)}
			</section>

			<section className="mt-8">
				<h2 className="mb-3 text-lg font-medium">Run a bulk export</h2>
				<Form method="post" className="flex flex-wrap items-end gap-3">
					<input type="hidden" name="intent" value="export" />
					<label className="flex flex-col gap-1">
						<span className="text-xs text-muted-foreground">Resource</span>
						<select
							name="resource"
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
					<button
						type="submit"
						disabled={busy}
						className="h-9 rounded-md bg-primary px-4 text-sm font-medium text-primary-foreground shadow transition-colors hover:bg-primary/90"
					>
						Enqueue export
					</button>
					<button
						type="button"
						onClick={() => revalidator.revalidate()}
						className="h-9 rounded-md border border-border px-4 text-sm"
					>
						Refresh
					</button>
				</Form>
			</section>

			<section className="mt-8">
				<h2 className="mb-3 text-lg font-medium">Recent jobs</h2>
				{view.jobs.length === 0 ? (
					<p className="text-sm text-muted-foreground">
						No jobs yet — a webhook subscription's next event, or the export
						form above, will enqueue one.
					</p>
				) : (
					<div className="rounded-md border border-border">
						<Table>
							<TableHeader className="bg-muted/50 text-xs">
								<TableRow>
									<TableHead>Type</TableHead>
									<TableHead>Status</TableHead>
									<TableHead>Attempts</TableHead>
									<TableHead>Created</TableHead>
									<TableHead>Updated</TableHead>
									<TableHead>Detail</TableHead>
								</TableRow>
							</TableHeader>
							<TableBody>
								{view.jobs.map((job) => {
									const download = downloadHrefFor(job)
									return (
										<TableRow key={job.id}>
											<TableCell className="font-mono text-xs">
												{job.type}
											</TableCell>
											<TableCell>
												<Badge variant={STATUS_VARIANT[job.status]}>
													{job.status}
												</Badge>
											</TableCell>
											<TableCell>
												{job.attempts}/{job.maxAttempts}
											</TableCell>
											<TableCell className="text-xs text-muted-foreground">
												<Stamp iso={job.createdAt} />
											</TableCell>
											<TableCell className="text-xs text-muted-foreground">
												<Stamp iso={job.updatedAt} />
											</TableCell>
											<TableCell className="text-xs">
												{download ? (
													<a
														href={download}
														download={`${(job.payload as unknown as { resource?: string } | null)?.resource ?? 'export'}.csv`}
														className="text-primary underline"
													>
														Download CSV
													</a>
												) : job.error ? (
													<span className="text-destructive" title={job.error}>
														{job.error.slice(0, 60)}
													</span>
												) : (
													'—'
												)}
											</TableCell>
										</TableRow>
									)
								})}
							</TableBody>
						</Table>
					</div>
				)}
			</section>
		</main>
	)
}
