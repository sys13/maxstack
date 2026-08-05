/**
 * `/imports/:key` — upload, dry-run report, explicit confirm.
 *
 * The route is thin on purpose. Every rule that matters — the `create`
 * authorization and the `update` one when the importer can upsert, the api-key
 * scope, the tenant and soft-delete scoping on the upsert lookup, the per-row
 * validation, the per-value caps of issue #172 and the audit attribution of
 * #186/#141 — lives in `planImport`/`opApplyImport`, which are built out of
 * `opList`, `opCreate` and `opUpdate` rather than beside them. Issue #186's
 * finding was that a route-level gate is a gate the other callers skip; this
 * route inherits the fix rather than re-creating the problem.
 *
 * ## The confirm re-plans; it never trusts a plan the client sends back
 *
 * The obvious implementation is to hold the plan in a hidden field and apply the
 * one that comes back. That is the bug: **a client-supplied plan is a
 * client-supplied write list** — row ids to overwrite and values to write into
 * them, already carrying the platform's own "validated" stamp. Every check
 * `planImport` performed would be reduced to trusting the browser to hand back
 * what it was given.
 *
 * So the confirm re-posts the *file*, and the action re-runs `planImport`
 * server-side before applying. The cost is parsing the upload twice; the benefit
 * is that the only plan that can ever be applied is one this server built. The
 * report the person read and the plan that runs are the same computation over
 * the same bytes — and where they differ, they differ because the *data* changed
 * underneath, which is exactly the case the per-row failure report exists for.
 */

import {
	describeImportPlan,
	type ImportPlan,
	importFailureCsv,
	opApplyImport,
	PermissionError,
	planImport,
	UnknownResourceError,
	UnsupportedOperationError,
} from '@maxstack/core'
import {
	Badge,
	type BadgeVariant,
	Table,
	TableBody,
	TableCell,
	TableHead,
	TableHeader,
	TableRow,
} from '@maxstack/ui'
import { data, Form, useNavigation } from 'react-router'
import { withRequestObservability } from '~/observability.server'
import { OWNED_IMPORT_PARSERS } from '~/owned.generated'
import { checkApiKeyScope, getContext } from '~/sprout.server'
import type { Route } from './+types/imports.$key'

/** How much of a dry-run report is worth rendering in one page. */
const MAX_REPORTED_ROWS = 200

/** A browser `File` as the chunk stream the readers take. */
async function* fileChunks(file: File): AsyncGenerator<Uint8Array> {
	const reader = file.stream().getReader()
	while (true) {
		const { done, value } = await reader.read()
		if (done) break
		if (value) yield value
	}
}

export async function loader({ request, params }: Route.LoaderArgs) {
	const ctx = await getContext(request)
	const found = ctx.registry.findImporter(params.key)
	if (!found) throw data({ error: 'Unknown importer' }, { status: 404 })
	// Scoped against the resource the importer writes, not against an "imports"
	// pseudo-resource: a key that may create cards may run a card importer, and
	// one that may not, cannot. Inventing a scope for the upload would let a key
	// write rows through a URL its scope never mentioned.
	const denied = checkApiKeyScope(ctx, found.entry.resource.name, 'POST')
	if (denied) throw denied
	return { importer: found.plan }
}

type ActionData =
	| { error: string }
	| { stage: 'planned'; plan: ImportPlan; shown: number; failureCsv: string }
	| {
			stage: 'applied'
			created: number
			updated: number
			skipped: number
			failed: { line: number; reason: string }[]
	  }

export async function action({ request, params }: Route.ActionArgs) {
	const ctx = await getContext(request)
	return withRequestObservability(request, ctx.user, async () => {
		const found = ctx.registry.findImporter(params.key)
		if (!found)
			return Response.json({ error: 'Unknown importer' }, { status: 404 })
		const denied = checkApiKeyScope(ctx, found.entry.resource.name, 'POST')
		if (denied) return denied

		const form = await request.formData()
		const file = form.get('file')
		if (!(file instanceof File) || file.size === 0)
			return Response.json({ error: 'Choose a file first.' }, { status: 400 })
		const confirmed = form.get('intent') === 'apply'

		try {
			// Always planned, on both paths. On the confirm path this is the
			// re-plan — see the module comment: the alternative is applying a write
			// list the client composed.
			// The parser slot for a `format: 'custom'` importer, from
			// the project's generated `imports/imports.generated.ts`.
			// `undefined` for every built-in format — those read themselves — and
			// for a custom importer whose parser has not been generated yet, which
			// still throws naming the module to write.
			const plan = await planImport(ctx, params.key, fileChunks(file), {
				parser: OWNED_IMPORT_PARSERS[params.key],
			})
			if (!confirmed) {
				const body: ActionData = {
					stage: 'planned',
					plan: {
						...plan,
						rows: plan.rows.slice(0, MAX_REPORTED_ROWS),
					},
					shown: Math.min(plan.rows.length, MAX_REPORTED_ROWS),
					failureCsv: importFailureCsv(plan),
				}
				return Response.json(body)
			}
			const result = await opApplyImport(ctx, plan)
			const body: ActionData = { stage: 'applied', ...result }
			return Response.json(body)
		} catch (error) {
			// A denial is a denial and a refusal is a refusal — never a partial
			// import with a green banner. Every one of these arrives before anything
			// was written, because the plan is built in full before the first write.
			if (error instanceof PermissionError)
				return Response.json({ error: 'Forbidden' }, { status: 403 })
			if (error instanceof UnknownResourceError)
				return Response.json({ error: 'Unknown importer' }, { status: 404 })
			if (error instanceof UnsupportedOperationError)
				return Response.json({ error: error.message }, { status: 422 })
			return Response.json(
				{
					error:
						error instanceof Error ? error.message : 'Could not read the file',
				},
				{ status: 400 },
			)
		}
	})
}

const ACTION_VARIANT: Record<string, BadgeVariant> = {
	create: 'success',
	update: 'warning',
	invalid: 'destructive',
}

export default function ImportPage({
	loaderData,
	actionData,
}: Route.ComponentProps) {
	const { importer } = loaderData
	const result = actionData as ActionData | undefined
	const nav = useNavigation()
	const busy = nav.state !== 'idle'
	const planned = result && 'stage' in result && result.stage === 'planned'
	const applied = result && 'stage' in result && result.stage === 'applied'

	return (
		<main className="mx-auto max-w-3xl px-6 py-10">
			<h1 className="text-2xl font-semibold">{importer.key}</h1>
			<p className="mt-1 text-sm text-muted-foreground">
				{importer.description}
			</p>

			<dl className="mt-4 grid gap-x-6 gap-y-1 text-xs text-muted-foreground sm:grid-cols-2">
				<div>
					<dt className="inline font-medium">Format </dt>
					<dd className="inline">{importer.format}</dd>
				</div>
				<div>
					<dt className="inline font-medium">Rows land in </dt>
					<dd className="inline">{importer.resource}</dd>
				</div>
				<div>
					<dt className="inline font-medium">At most </dt>
					<dd className="inline">{importer.maxRows} rows per run</dd>
				</div>
				<div>
					{/* The one fact a person most needs before uploading anything, said
					    in words rather than as a field name. */}
					<dt className="inline font-medium">Existing rows </dt>
					<dd className="inline">
						{importer.upsertColumn
							? `are OVERWRITTEN when ${importer.upsertColumn} matches`
							: 'are never touched — this only adds rows'}
					</dd>
				</div>
			</dl>

			{importer.paused ? (
				<p className="mt-6 rounded-md border border-border bg-muted/40 p-3 text-sm">
					This importer is paused and will not accept a file.
				</p>
			) : (
				<Form method="post" encType="multipart/form-data" className="mt-6">
					<input type="hidden" name="intent" value="plan" />
					<label className="flex flex-col gap-1">
						<span className="text-xs text-muted-foreground">File</span>
						<input
							type="file"
							name="file"
							required
							disabled={busy}
							className="text-sm"
						/>
					</label>
					<button
						type="submit"
						disabled={busy}
						className="mt-3 h-9 rounded-md bg-primary px-4 text-sm font-medium text-primary-foreground shadow transition-colors hover:bg-primary/90"
					>
						Check this file
					</button>
					<p className="mt-2 text-xs text-muted-foreground">
						Nothing is written until you confirm the report.
					</p>
				</Form>
			)}

			{result && 'error' in result ? (
				<p className="mt-6 rounded-md border border-destructive/40 p-3 text-sm text-destructive">
					{result.error}
				</p>
			) : null}

			{planned ? (
				<section className="mt-8">
					<h2 className="text-lg font-medium">
						What would change — {describeImportPlan(result.plan)}
					</h2>
					<p className="mt-1 text-sm text-muted-foreground">
						Nothing has been written yet. Rejected rows are never attempted, so
						confirming imports the{' '}
						{result.plan.counts.create + result.plan.counts.update} row(s) below
						that are marked new or updated.
					</p>

					{result.plan.counts.invalid > 0 ? (
						<p className="mt-3 text-sm">
							<a
								href={`data:text/csv;charset=utf-8,${encodeURIComponent(result.failureCsv)}`}
								download={`${importer.key}-rejected.csv`}
								className="text-primary underline"
							>
								Download the {result.plan.counts.invalid} rejected row(s)
							</a>{' '}
							— one row per line, with the value and the reason, so it can be
							fixed and re-uploaded.
						</p>
					) : null}

					<div className="mt-4 rounded-md border border-border">
						<Table>
							<TableHeader className="bg-muted/50 text-xs">
								<TableRow>
									<TableHead>Line</TableHead>
									<TableHead>Action</TableHead>
									<TableHead>Detail</TableHead>
								</TableRow>
							</TableHeader>
							<TableBody>
								{result.plan.rows.map((row) => (
									<TableRow key={row.line}>
										<TableCell className="font-mono text-xs">
											{row.line}
										</TableCell>
										<TableCell>
											<Badge variant={ACTION_VARIANT[row.action]}>
												{row.action}
											</Badge>
										</TableCell>
										<TableCell className="text-xs">
											{row.action === 'invalid'
												? Object.entries(row.errors ?? {})
														.map(
															([field, messages]) =>
																`${field}: ${messages.join(' ')}`,
														)
														.join('; ')
												: row.action === 'update'
													? `matches ${row.matchedId}`
													: '—'}
										</TableCell>
									</TableRow>
								))}
							</TableBody>
						</Table>
					</div>
					{result.plan.rows.length > result.shown ? (
						<p className="mt-2 text-xs text-muted-foreground">
							Showing the first {result.shown} of {result.plan.rows.length}{' '}
							planned rows. All of them are imported on confirm.
						</p>
					) : null}

					{/* The confirm re-posts the FILE, not the plan. See the module
					    comment: a plan sent back by the client is a write list the
					    client composed. */}
					<Form
						method="post"
						encType="multipart/form-data"
						className="mt-4 flex flex-wrap items-end gap-3"
					>
						<input type="hidden" name="intent" value="apply" />
						<label className="flex flex-col gap-1">
							<span className="text-xs text-muted-foreground">
								Re-select the same file to confirm
							</span>
							<input
								type="file"
								name="file"
								required
								disabled={busy}
								className="text-sm"
							/>
						</label>
						<button
							type="submit"
							disabled={busy}
							className="h-9 rounded-md bg-primary px-4 text-sm font-medium text-primary-foreground shadow"
						>
							{importer.upsertColumn
								? `Import — this can overwrite ${result.plan.counts.update} existing row(s)`
								: 'Import'}
						</button>
					</Form>
				</section>
			) : null}

			{applied ? (
				<section className="mt-8">
					<h2 className="text-lg font-medium">Imported</h2>
					<p className="mt-1 text-sm">
						{result.created} created, {result.updated} updated, {result.skipped}{' '}
						skipped as invalid.
					</p>
					{result.failed.length > 0 ? (
						<div className="mt-3 rounded-md border border-destructive/40 p-3">
							<p className="text-sm text-destructive">
								{result.failed.length} row(s) were fine in the report and failed
								at write time — something changed underneath. The rest landed.
							</p>
							<ul className="mt-2 space-y-1 text-xs text-destructive">
								{result.failed.map((f) => (
									<li key={f.line}>
										line {f.line}: {f.reason}
									</li>
								))}
							</ul>
						</div>
					) : null}
				</section>
			) : null}
		</main>
	)
}
