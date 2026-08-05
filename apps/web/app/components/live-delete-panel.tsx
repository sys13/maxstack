import { useDelete, useList } from '@maxstack/ui'

/**
 * Task-33 exit proof: a *hand-written* component (the kind an app author drops
 * into a slot) that fetches and mutates a resource in three lines of library —
 *
 *   const { data } = useList(resource, { pagination: { page: 1, perPage: 5 } })
 *   const [remove] = useDelete(resource)
 *   remove(id, { mode: 'undoable' })   // optimistic removal + an undo toast
 *
 * — and gets cache-wired fetching plus optimistic delete-with-undo for free.
 * No loader, no fetch plumbing, no manual cache: the hooks read the same REST
 * API the admin loaders use, and the undo toast is the `<Notifications>` renderer
 * mounted by the admin layout.
 */
export function LiveDeletePanel({
	resource,
	titleField,
}: {
	resource: string
	titleField: string | null
}) {
	const { data, total } = useList(resource, {
		pagination: { page: 1, perPage: 5 },
	})
	const [remove, { isLoading: deleting }] = useDelete(resource)

	// `data` is undefined until the first client fetch resolves (on the server
	// it never runs), so treat "no data yet" as loading rather than empty.
	const loading = data === undefined
	const rows = data ?? []
	const display = (row: Record<string, unknown>) =>
		String((titleField && row[titleField]) ?? row.id ?? '—')

	return (
		<section className="mt-8 rounded-lg border border-border p-4">
			<h2 className="text-lg font-semibold">Live (client-fetched)</h2>
			<p className="mb-3 text-sm text-muted-foreground">
				Fetched in the browser via <code>useList</code>; delete is optimistic
				with undo via <code>useDelete</code>. {total} record
				{total === 1 ? '' : 's'} total.
			</p>
			{loading ? (
				<p className="text-sm text-muted-foreground">Loading…</p>
			) : rows.length === 0 ? (
				<p className="text-sm text-muted-foreground">No records.</p>
			) : (
				<ul className="m-0 list-none space-y-1 p-0">
					{rows.map((row) => (
						<li
							key={String(row.id)}
							className="flex items-center justify-between gap-3 rounded-md px-2 py-1.5 text-sm hover:bg-accent"
						>
							<span className="min-w-0 flex-1 truncate">{display(row)}</span>
							<button
								type="button"
								disabled={deleting}
								onClick={() =>
									remove(String(row.id), {
										mode: 'undoable',
										undoMessage: `Deleted "${display(row)}".`,
									})
								}
								className="rounded-md border border-border px-2 py-0.5 text-xs text-muted-foreground hover:text-foreground disabled:opacity-50"
							>
								Delete
							</button>
						</li>
					))}
				</ul>
			)}
		</section>
	)
}
