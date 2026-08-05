/**
 * Create a record on a project page (task 21). Same Sprout `createHandler` +
 * DynamicForm as the admin, but presented as the running app's own page and
 * redirecting back to the page's list rather than `/admin`.
 */

import { generateValidationSchema, type SproutResource } from '@maxstack/core'
import { Alert, DynamicForm, referenceUiOptions } from '@maxstack/ui'
import { useState } from 'react'
import { Link, useFetcher } from 'react-router'
import { DescribePrefill } from '~/components/describe-prefill'
import { pageNoun } from '~/page-noun'
import { pagePath } from '~/page-path'
import { ProjectFrame } from '~/project-nav'

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
export function formResource(resource: SproutResource): SproutResource {
	return {
		...resource,
		columns: resource.columns.filter((c) => c.meta?.hidden !== true),
	}
}

/**
 * What a failed write hands back to the form.
 *
 * Typed by what this component consumes rather than by `typeof action`: since
 * issue #251 these forms post to the splat route, whose action covers list, new,
 * edit and parse, so the enclosing route's action type is no longer this
 * module's. The successful path is a redirect and carries no data either way.
 */
interface WriteErrors {
	fieldErrors?: Record<string, string[]>
}

import type { loader } from './project.new.server'

export default function NewProjectRecord({
	loaderData,
}: {
	loaderData: Awaited<ReturnType<typeof loader>>
}) {
	const {
		page,
		nav,
		title,
		theme,
		demoRows,
		introspection,
		referenceOptions,
		aiConfigured,
	} = loaderData
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
		<ProjectFrame pages={nav} title={title} theme={theme} demoRows={demoRows}>
			<section className="max-w-lg">
				<Link
					to={pagePath(page.slug)}
					className="text-sm text-muted-foreground no-underline hover:text-foreground"
				>
					&larr; {page.name}
				</Link>
				{/* The entity, not the page: the back-link above goes to the
				    page, so it wears the page's name — but this form creates a row,
				    and on a "Shelf" page over books that row is a book. */}
				<h1 className="mt-2 mb-6 text-2xl font-semibold">
					New {pageNoun(page)}
				</h1>
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
					action={pagePath(page.slug, 'parse')}
					onFields={setPrefill}
					available={aiConfigured}
				/>
				<DynamicForm
					key={prefill ? JSON.stringify(prefill) : 'blank'}
					schema={schema}
					defaultValues={prefill}
					columns={form.columns}
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
		</ProjectFrame>
	)
}
