/**
 * The generic admin's create form.
 *
 * No longer a route module: `routes/admin.$.tsx` resolves what a
 * path under `/admin` means and renders this when the answer is "create a
 * record"; the loader and action live in `admin.resource.new.server.ts`.
 */

import { generateValidationSchema, type SproutResource } from '@maxstack/core'
import { Alert, DynamicForm, referenceUiOptions } from '@maxstack/ui'
import { useState } from 'react'
import { Link, useFetcher } from 'react-router'
import { DescribePrefill } from '~/components/describe-prefill'
import type { loader } from './admin.resource.new.server'

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

export default function NewRecord({
	loaderData,
}: {
	loaderData: Awaited<ReturnType<typeof loader>>
}) {
	const { resource, label, introspection, referenceOptions, aiConfigured } =
		loaderData
	const fetcher = useFetcher<WriteErrors>()
	// Hidden columns are filtered before the schema is generated, because the
	// form's field list comes from the schema.
	const form = formResource(introspection as SproutResource)
	const schema = generateValidationSchema(form, 'create')
	const uiOptions = referenceUiOptions(
		(introspection as SproutResource).columns,
		referenceOptions,
	)

	const fieldErrors = fetcher.data?.fieldErrors
	// AI-extracted fields from the describe box. Conform seeds field values at
	// mount, so remount the form (key) whenever a new extraction lands.
	const [prefill, setPrefill] = useState<Record<string, unknown>>()

	return (
		<section className="max-w-lg">
			<Link
				to={`/admin/${resource}`}
				className="text-sm text-muted-foreground no-underline hover:text-foreground"
			>
				&larr; {label}
			</Link>
			<h1 className="mt-2 mb-6 text-2xl font-semibold">New {label}</h1>
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
			/>
			<DynamicForm
				key={prefill ? JSON.stringify(prefill) : 'blank'}
				schema={schema}
				columns={form.columns}
				defaultValues={prefill}
				uiOptions={uiOptions}
				submitLabel={fetcher.state === 'idle' ? 'Create' : 'Saving…'}
				onSubmit={(values) =>
					fetcher.submit(values as Parameters<typeof fetcher.submit>[0], {
						method: 'post',
						encType: 'application/json',
					})
				}
			/>
		</section>
	)
}
