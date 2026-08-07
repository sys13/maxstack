/**
 * Edit or delete a record on a project page (task 21). Same Sprout
 * get/update/delete handlers + DynamicForm as the admin, presented as the
 * running app's own page and redirecting back to the page's list.
 */

import { generateValidationSchema, type SproutResource } from '@maxstack/core'
import {
	Alert,
	ConfirmButton,
	DynamicForm,
	RelatedRecords,
	referenceUiOptions,
} from '@maxstack/ui'
import { useState } from 'react'
import { Link, useFetcher } from 'react-router'
import { DescribePrefill } from '~/components/describe-prefill'
import { hasLiveSurface, LiveSurface } from '~/live-surface'
import { pageNoun } from '~/page-noun'
import { pagePath } from '~/page-path'
import { ProjectFrame } from '~/project-nav'
import { relatedListHref } from '~/related-link'
import { useLivePresence } from '~/use-live-presence'

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

import type { loader } from './project.edit.server'

export default function EditProjectRecord({
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
		row,
		introspection,
		referenceOptions,
		files,
		liveSlot,
		primaryKey,
		aiConfigured,
		related,
	} = loaderData
	const liveSurface = hasLiveSurface(liveSlot?.key) ? liveSlot : undefined
	const rowId = String(row[primaryKey] ?? '')
	// The hook is called unconditionally with possibly-undefined arguments —
	// React's rule, and it costs nothing: with no channel it opens no connection
	// and makes no request.
	const presence = useLivePresence(
		liveSurface?.key,
		liveSurface ? rowId : undefined,
		liveSurface?.presenceTtlSeconds,
	)
	const save = useFetcher<WriteErrors>()
	const del = useFetcher()
	// Hidden columns are filtered before the schema is generated, because the
	// form's field list comes from the schema.
	const form = formResource(introspection as SproutResource)
	const schema = generateValidationSchema(form, 'update')
	const uiOptions = referenceUiOptions(
		(introspection as SproutResource).columns,
		referenceOptions,
	)
	const fieldErrors = save.data?.fieldErrors
	// AI-adjusted values from the describe box, over the row as loaded. Conform
	// seeds field values at mount, so the form is remounted (key) whenever a new
	// extraction lands — same trick as the create form.
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
				{/* The entity, not the page — same as the create form. */}
				<h1 className="mt-2 mb-6 text-2xl font-semibold">
					Edit {pageNoun(page)}
				</h1>
				{/* The bespoke presence surface, above the form it is about. It gets
				    identities and a join time and nothing else — no cursor, no
				    selection, no "currently typing" — because that is the whole of
				    what the channel carries (d-live-last-write-wins). `rows` is the
				    one row the channel is bounded to; a presence channel declares no
				    fields, so there is nothing else on it to hand over. */}
				{liveSurface ? (
					<LiveSurface
						channelKey={liveSurface.key}
						rows={[{ id: rowId }]}
						present={presence.present}
						truncated={presence.truncated}
						// Presence has no stream to lose: it is a POST loop by
						// construction, so it is never "arriving by poll instead".
						polling={false}
					/>
				) : null}
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
					existing={prefill ?? row}
					// The id is what the update posts against; a "clear the rest" pass
					// must not take it with the fields it drops.
					keepOnReplace={[primaryKey]}
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
				<del.Form method="post" className="mt-10 border-t border-border pt-6">
					<input type="hidden" name="intent" value="delete" />
					{/* Two-step, not one click: Delete sits next to Save
					    and there is no undo behind it. */}
					<ConfirmButton
						label="Delete"
						confirmLabel="Delete this record? This cannot be undone."
						pendingLabel="Deleting…"
						pending={del.state !== 'idle'}
					/>
				</del.Form>
				{/*
				  The records that reference this one — the inverse of
				  every declared FK, rendered rather than re-hand-written per app.

				  A section links only when the referencing entity has a navigable
				  page of its own: `nav` is the accepted, flag-visible page set, so a
				  child entity with no page (or one this viewer cannot see) shows its
				  rows without linking anywhere, instead of linking at a 404.

				  The count beside each heading is the section's "view all": it links
				  to the child's own list, filtered to this record. Which sections get
				  one is `relatedListHref`'s decision and is deliberately narrower
				  than "all of them" — see it for why, and for why the filter is not
				  merely permitted through the list page's column narrowing.
				*/}
				{related.length > 0 ? (
					<div className="mt-10 border-t border-border pt-6">
						<RelatedRecords
							title="Related"
							groups={related}
							linkComponent={Link}
							listHref={(group) => relatedListHref(nav, group, rowId)}
							rowHref={(group, childRow) => {
								const slug = nav.find(
									(p) => p.resource === group.resource,
								)?.slug
								const childId = String(
									childRow[group.introspection.primaryKey] ?? '',
								)
								return slug === undefined || childId === ''
									? undefined
									: pagePath(slug, childId)
							}}
						/>
					</div>
				) : null}
			</section>
		</ProjectFrame>
	)
}
