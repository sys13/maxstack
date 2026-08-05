/**
 * The generic admin's list page — one CRUD surface derived from the registry.
 *
 * No longer a route module: `routes/admin.$.tsx` resolves what a
 * path under `/admin` means — asking the spec first, so a declared project page
 * wins — and renders this when the answer is the generic list. Its loader lives
 * in `admin.resource.server.ts`, because a plain module ships whatever it
 * imports to the browser.
 */

import type { SproutResource } from '@maxstack/core'
import {
	downloadCsv,
	FilterForm,
	filtersFromSearchParams,
	filtersToSearchParams,
	ResourceList,
	resourceToCsv,
	SavedQueries,
} from '@maxstack/ui'
import { useEffect, useState } from 'react'
import { Link, useRevalidator, useSearchParams } from 'react-router'
import type { loader } from './admin.resource.server'

/** RR `<Link>` adapted to the ui `linkComponent` contract. */
const link = ({
	to,
	children,
	className,
}: {
	to: string
	children: React.ReactNode
	className?: string
}) => (
	<Link to={to} className={className}>
		{children}
	</Link>
)

const barButton =
	'inline-flex h-8 items-center rounded-md border border-border bg-background px-3 text-sm font-medium shadow-sm hover:bg-muted'

export default function ResourceListPage({
	loaderData,
}: {
	loaderData: Awaited<ReturnType<typeof loader>>
}) {
	const {
		resource,
		label,
		introspection,
		titleField,
		rows,
		references,
		files,
		referenceOptions,
		can,
		softDelete,
	} = loaderData
	const [searchParams, setSearchParams] = useSearchParams()
	const revalidator = useRevalidator()
	// Saved queries live in localStorage (the prefs store), which the server
	// can't see — render the chip bar only after hydration to avoid a mismatch.
	const [hydrated, setHydrated] = useState(false)
	useEffect(() => setHydrated(true), [])

	// The URL is the single source of truth for filter state.
	const filters = filtersFromSearchParams(searchParams)
	const detailHref = (row: Record<string, unknown>) =>
		`/admin/${resource}/${String(row[introspection.primaryKey])}`

	// The one hand-owned cell — the eject seam. The title column links to the
	// record; every other column stays inferred by <ResourceList>.
	const columns = titleField
		? {
				[titleField]: ({
					value,
					row,
				}: {
					value: unknown
					row: Record<string, unknown>
				}) => (
					<Link
						to={detailHref(row)}
						className="font-medium underline-offset-4 hover:underline"
					>
						{String(value ?? '—')}
					</Link>
				),
			}
		: undefined

	// Edit-in-place (task 40): every plain scalar column edits inline. References
	// need the picker (the row link), and the system columns are server-owned —
	// the same set the revision-restore path refuses to write.
	const editable = introspection.columns
		.filter(
			(c) =>
				c.name !== introspection.primaryKey &&
				!c.references &&
				c.meta?.hidden !== true &&
				c.name !== titleField &&
				!['createdAt', 'updatedAt', 'created_at', 'updated_at'].includes(
					c.name,
				),
		)
		.map((c) => c.name)

	async function saveCell(
		row: Record<string, unknown>,
		column: string,
		value: unknown,
	) {
		const id = String(row[introspection.primaryKey])
		await fetch(`/api/${resource}/${encodeURIComponent(id)}`, {
			method: 'PATCH',
			headers: { 'Content-Type': 'application/json' },
			body: JSON.stringify({ [column]: value }),
		})
		revalidator.revalidate()
	}

	async function bulkDelete(ids: string[]) {
		await Promise.all(
			ids.map((id) =>
				fetch(`/api/${resource}/${encodeURIComponent(id)}`, {
					method: 'DELETE',
				}),
			),
		)
		revalidator.revalidate()
	}

	return (
		<section>
			<header className="mb-4 flex items-center justify-between">
				<h1 className="text-2xl font-semibold">{label}</h1>
				<div className="flex items-center gap-2">
					{softDelete ? (
						<Link to={`/admin/${resource}/trash`} className={barButton}>
							Trash
						</Link>
					) : null}
					<button
						type="button"
						className={barButton}
						onClick={() =>
							downloadCsv(
								`${resource}.csv`,
								resourceToCsv(introspection as SproutResource, rows, {
									references,
								}),
							)
						}
					>
						Export CSV
					</button>
					{can.create ? (
						<Link
							to={`/admin/${resource}/new`}
							className="inline-flex h-9 items-center rounded-md bg-primary px-4 text-sm font-medium text-primary-foreground no-underline shadow transition-colors hover:bg-primary/90"
						>
							+ New
						</Link>
					) : null}
				</div>
			</header>

			<FilterForm
				resource={introspection as SproutResource}
				value={filters}
				onChange={(next) =>
					setSearchParams(filtersToSearchParams(next), {
						replace: true,
						preventScrollReset: true,
					})
				}
				referenceOptions={referenceOptions}
				className="mb-4"
			/>

			{/* Saved queries (task 40): presets persist to the preference store and
			    apply by writing the same URL params the filter form emits. */}
			{hydrated ? (
				<SavedQueries
					resource={resource}
					value={filters}
					onApply={({ values }) =>
						setSearchParams(filtersToSearchParams(values), {
							replace: true,
							preventScrollReset: true,
						})
					}
					className="mb-4"
				/>
			) : null}

			<ResourceList
				resource={introspection as SproutResource}
				rows={rows}
				references={references}
				files={files}
				columns={columns}
				rowHref={detailHref}
				linkComponent={link}
				editable={editable}
				onCellSave={saveCell}
				selectable
				can={can}
				bulkActions={({ selectedIds, selectedRows, clear, can: cap }) => (
					<>
						<button
							type="button"
							className={barButton}
							onClick={() =>
								downloadCsv(
									`${resource}-selected.csv`,
									resourceToCsv(introspection as SproutResource, selectedRows, {
										references,
									}),
								)
							}
						>
							Export CSV
						</button>
						{cap.delete ? (
							<button
								type="button"
								className={barButton}
								onClick={async () => {
									await bulkDelete(selectedIds)
									clear()
								}}
							>
								Delete
							</button>
						) : null}
					</>
				)}
			/>
		</section>
	)
}
