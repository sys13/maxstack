/**
 * Soft-delete trash — the small "recoverable within a window"
 * admin affordance the exit criterion asks for: list a `softDelete: true`
 * resource's soft-deleted rows and restore one. Deliberately minimal (no
 * filters/CSV/bulk actions like `admin.resource.tsx`) — this is a trash can,
 * not a second CRUD surface. Rows past the retention window are gone before
 * they'd ever show up here: `schedulePurgeJob` (`@maxstack/features/compliance`)
 * hard-deletes them on its own schedule.
 *
 * No longer a route module: `routes/admin.$.tsx` resolves what a
 * path under `/admin` means and renders this when the answer is a trash can; the
 * loader and action live in `admin.resource.trash.server.ts`.
 */

import { Timestamp } from '@maxstack/ui'
import { Form, Link, useNavigation } from 'react-router'
import type { loader } from './admin.resource.trash.server'

export default function TrashPage({
	loaderData,
}: {
	loaderData: Awaited<ReturnType<typeof loader>>
}) {
	const { resource, label, softDelete, titleField, rows } = loaderData
	const nav = useNavigation()
	const busy = nav.state !== 'idle'

	if (!softDelete) {
		return (
			<section>
				<header className="mb-4 flex items-center justify-between">
					<h1 className="text-2xl font-semibold">{label} — Trash</h1>
					<Link
						to={`/admin/${resource}`}
						className="text-sm text-muted-foreground underline-offset-4 hover:underline"
					>
						Back to {label}
					</Link>
				</header>
				<p className="text-sm text-muted-foreground">
					{label} doesn't keep a trash. Deleting a row removes it immediately —
					declare <code className="font-mono text-xs">softDelete</code> on the
					entity to get a recovery window instead.
				</p>
			</section>
		)
	}

	return (
		<section>
			<header className="mb-4 flex items-center justify-between">
				<h1 className="text-2xl font-semibold">{label} — Trash</h1>
				<Link
					to={`/admin/${resource}`}
					className="text-sm text-muted-foreground underline-offset-4 hover:underline"
				>
					Back to {label}
				</Link>
			</header>
			<p className="mb-4 text-sm text-muted-foreground">
				Soft-deleted rows, recoverable until the retention window purges them.
			</p>
			{rows.length === 0 ? (
				<p className="text-sm text-muted-foreground">Nothing in the trash.</p>
			) : (
				<ul className="divide-y divide-border rounded-md border border-border">
					{rows.map((row) => (
						<li
							key={String(row.id)}
							className="flex flex-wrap items-center gap-3 px-4 py-3"
						>
							<span className="min-w-0 flex-1 truncate text-sm">
								{titleField ? String(row[titleField] ?? '—') : String(row.id)}
								<span className="ml-2 text-xs text-muted-foreground">
									deleted{' '}
									{row.deletedAt ? (
										<Timestamp
											iso={new Date(String(row.deletedAt)).toISOString()}
										/>
									) : (
										''
									)}
								</span>
							</span>
							<Form method="post">
								<input type="hidden" name="id" value={String(row.id)} />
								<button
									type="submit"
									disabled={busy}
									className="h-8 cursor-pointer rounded-md border border-border bg-transparent px-2 text-xs hover:bg-muted"
								>
									Restore
								</button>
							</Form>
						</li>
					))}
				</ul>
			)}
		</section>
	)
}
