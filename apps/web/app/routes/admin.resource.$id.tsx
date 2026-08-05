/**
 * The generic admin's record page — read-only detail, edit form, delete, the
 * records that reference this one, and per-record history.
 *
 * No longer a route module: `routes/admin.$.tsx` resolves what a
 * path under `/admin` means — asking the spec first, so a declared project page
 * wins — and renders this when the answer is a record; the loader and action
 * live in `admin.resource.$id.server.ts`.
 */

import { generateValidationSchema, type SproutResource } from '@maxstack/core'
import {
	Alert,
	ConfirmButton,
	DynamicForm,
	History,
	RelatedRecords,
	referenceUiOptions,
	Show,
} from '@maxstack/ui'
import { useState } from 'react'
import { Link, useFetcher } from 'react-router'
import { DescribePrefill } from '~/components/describe-prefill'
import type { loader } from './admin.resource.$id.server'

/**
 * What a failed write hands back to the form.
 *
 * Typed by what this component consumes rather than by `typeof action`: since
 * issue #252 this form posts to the admin splat, whose action covers create,
 * edit, delete and restore, so the enclosing route's action type is no longer
 * this module's. The successful path is a redirect and carries no data either
 * way.
 */
interface WriteErrors {
	fieldErrors?: Record<string, string[]>
}

/**
 * The resource a form is built from: the introspected one minus the columns the
 * spec marked hidden.
 *
 * Every *read* surface in the UI package already honours `meta.hidden`; the form
 * path did not, which put a board's rank key — an opaque sort key the database
 * stamps and a drag rewrites — in front of people as an editable text box. The
 * form's field list comes from its Zod schema rather than from `columns`, so the
 * filtering has to happen before the schema is generated, not after.
 *
 * This narrows the *form*, never the server: `opUpdate` re-validates against the
 * full resource, so the column stays writable — which is what lets a board move
 * go through this same record's edit route instead of needing a write path of
 * its own.
 */
function formResource(resource: SproutResource): SproutResource {
	return {
		...resource,
		columns: resource.columns.filter((c) => c.meta?.hidden !== true),
	}
}

export default function EditRecord({
	loaderData,
}: {
	loaderData: Awaited<ReturnType<typeof loader>>
}) {
	const {
		resource,
		label,
		id,
		row,
		introspection,
		references,
		files,
		referenceOptions,
		related,
		can,
		history,
		documents,
		aiConfigured,
	} = loaderData
	const save = useFetcher<WriteErrors>()
	const del = useFetcher()
	// Hidden columns are filtered before the schema is generated, because the
	// form's field list comes from the schema.
	const form = formResource(introspection as SproutResource)
	const schema = generateValidationSchema(form, 'update')

	// Turn each FK column into an autocomplete picker over its referenced records
	// — a name picker instead of a raw id text box (Plan v5 task 32). An
	// array-reference column (`tags`) becomes the multi-value picker (task 38).
	const uiOptions = referenceUiOptions(
		(introspection as SproutResource).columns,
		referenceOptions,
	)

	const fieldErrors = save.data?.fieldErrors
	// AI-adjusted values from the describe box, over the row as loaded. Conform
	// seeds field values at mount, so the form is remounted (key) whenever a
	// new extraction lands.
	const [prefill, setPrefill] = useState<Record<string, unknown>>()

	return (
		<section className="max-w-lg">
			<Link
				to={`/admin/${resource}`}
				className="text-sm text-muted-foreground no-underline hover:text-foreground"
			>
				&larr; {label}
			</Link>
			<h1 className="mt-2 mb-6 text-2xl font-semibold">
				{can.update ? 'Edit' : 'View'} {label}
			</h1>
			{can.update ? (
				<>
					{/* Read-only detail — the display dual of the form below, inferred
					    from the same introspection via <Show> (Plan v5 task 31). */}
					<details className="mb-6 rounded-md border border-border p-4">
						<summary className="cursor-pointer text-sm font-medium text-muted-foreground">
							Record detail
						</summary>
						<div className="mt-4">
							<Show
								resource={introspection as SproutResource}
								record={row}
								references={references}
								files={files}
							/>
						</div>
					</details>
					{fieldErrors ? (
						<Alert
							variant="destructive"
							role="alert"
							className="mb-4 overflow-x-auto"
						>
							<pre>{JSON.stringify(fieldErrors, null, 2)}</pre>
						</Alert>
					) : null}
					<DescribePrefill
						action={`/admin/${resource}/parse`}
						onFields={setPrefill}
						available={aiConfigured}
						existing={prefill ?? row}
						// The id is what the update posts against; a "clear the rest" pass
						// must not take it with the fields it drops.
						keepOnReplace={[(introspection as SproutResource).primaryKey]}
					/>
					<DynamicForm
						key={prefill ? JSON.stringify(prefill) : 'loaded'}
						schema={schema}
						columns={form.columns}
						defaultValues={prefill ?? row}
						filePreviewUrl={(key) => files[key]?.url ?? ''}
						uiOptions={uiOptions}
						submitLabel={save.state === 'idle' ? 'Save' : 'Saving…'}
						onSubmit={(values) =>
							save.submit(values as Parameters<typeof save.submit>[0], {
								method: 'post',
								encType: 'application/json',
							})
						}
					/>
				</>
			) : (
				// No update permission → a read-only record view (task 35). The form is
				// gone entirely, not just disabled.
				<Show
					resource={introspection as SproutResource}
					record={row}
					references={references}
					files={files}
				/>
			)}
			{can.delete ? (
				<del.Form method="post" className="mt-10 border-t border-border pt-6">
					<input type="hidden" name="intent" value="delete" />
					{/* Two-step, not one click — same guard the project
					    record page carries, from the same component. */}
					<ConfirmButton
						label="Delete"
						confirmLabel="Delete this record? This cannot be undone."
						pendingLabel="Deleting…"
						pending={del.state !== 'idle'}
					/>
				</del.Form>
			) : null}
			{/*
			  Declared documents. A `documents.declare` used to produce a
			  URL and nothing else — no button, no nav entry, nothing — so somebody
			  declaring an invoice template saw the app not change and concluded it
			  had not worked. Every other op gives you a surface you can navigate to.

			  Plain anchors rather than `<Link>`: these are downloads served by a
			  resource route, not client-side navigations. `<Link>` would ask the
			  router to render a page for them, which is not what a PDF is.
			*/}
			{documents.length > 0 ? (
				<div className="mt-10 border-t border-border pt-6">
					<h2 className="mb-3 text-sm font-medium text-muted-foreground">
						Documents
					</h2>
					<ul className="space-y-3 text-sm">
						{documents.map((doc) => (
							<li key={doc.key}>
								<div className="font-medium">{doc.key}</div>
								<p className="text-muted-foreground">{doc.description}</p>
								<div className="mt-1 flex gap-3">
									<a
										href={`/documents/${doc.key}/${id}.pdf`}
										className="text-primary underline-offset-4 hover:underline"
									>
										PDF
									</a>
									<a
										href={`/documents/${doc.key}/${id}.html`}
										className="text-primary underline-offset-4 hover:underline"
									>
										HTML
									</a>
								</div>
							</li>
						))}
					</ul>
				</div>
			) : null}
			{/*
			  The records that point *at* this one — renewals under a
			  customer, comments under a story. Every section is derived from a
			  declared FK, so this is the same panel for every entity in every app;
			  it replaces a counts-only list, which told you twelve comments existed
			  and made reading them somebody's hand-written loader.
			*/}
			{related.length > 0 ? (
				<div className="mt-10 border-t border-border pt-6">
					<RelatedRecords
						title="Related"
						groups={related}
						linkComponent={Link}
						listHref={(g) => `/admin/${g.resource}?filter.${g.fk}=${id}`}
						rowHref={(g, row) =>
							`/admin/${g.resource}/${String(row[g.introspection.primaryKey] ?? '')}`
						}
					/>
				</div>
			) : null}
			{/* Per-record activity feed over the audit sink (task 35). */}
			<div className="mt-10 border-t border-border pt-6">
				<History entries={history} title="History" />
			</div>
		</section>
	)
}
