/**
 * `<RevisionHistory>` (Plan v5 task 46) — grows the task-35 audit feed into
 * versioning: each revision shows a field-level diff (before → after) and a
 * one-click restore. Presentation over `buildRevisions` (data is a prop, like
 * `<History>`/`<ResourceList>`); restore is delegated to an `onRestore` callback
 * the owning route wires to task-33's `useUpdate` (see `useRestore`). Field
 * values render through the semantic `<Field>` library when an introspected
 * `columns` map is supplied, else as plain text.
 */

import { type ReactNode, useMemo, useState } from 'react'
import type { IntrospectedColumn } from '../fields/field-semantics.ts'
import { Field } from '../fields/fields.tsx'
import { Timestamp } from '../format/timestamp.tsx'
import { cn } from '../lib/cn.ts'
import { buildRevisions, type FieldDiff, type Snapshot } from './diff.ts'

export interface RevisionHistoryProps {
	/** Snapshots for the record (any order; set `order` to match). */
	snapshots: Snapshot[]
	/** Order of `snapshots` (and of the rendered list); default newest-first. */
	order?: 'asc' | 'desc'
	/** Fields to exclude from the diff (default: pk + timestamps). */
	ignore?: string[]
	/** Introspected columns keyed by name, for semantic value rendering. */
	columns?: Record<string, IntrospectedColumn>
	/** Restore a revision's snapshot (wire to `useUpdate`); enables the button. */
	onRestore?: (snapshot: Snapshot) => void | Promise<void>
	title?: ReactNode
	emptyState?: ReactNode
	formatActor?: (userId: string) => string
	/**
	 * Render the ISO timestamp yourself.
	 *
	 * Omit it and the feed uses `<Timestamp>`, which server-renders a
	 * runtime-independent string and upgrades to the viewer's locale after mount
	 *. Supplying one makes hydration your problem.
	 */
	formatTimestamp?: (iso: string) => string
	className?: string
}

const DEFAULT_IGNORE = ['id', 'createdAt', 'updatedAt']

function ValueCell({
	field,
	value,
	columns,
}: {
	field: string
	value: unknown
	columns?: Record<string, IntrospectedColumn>
}) {
	if (value === undefined)
		return <span className="text-muted-foreground">—</span>
	const column = columns?.[field]
	if (column) return <Field value={value} column={column} />
	return (
		<span>
			{typeof value === 'object' ? JSON.stringify(value) : String(value)}
		</span>
	)
}

function DiffRow({
	change,
	columns,
}: {
	change: FieldDiff
	columns?: Record<string, IntrospectedColumn>
}) {
	return (
		<li className="flex flex-wrap items-baseline gap-2 text-sm">
			<span className="font-medium">{change.field}</span>
			{change.kind !== 'added' ? (
				<span className="text-muted-foreground line-through">
					<ValueCell
						field={change.field}
						value={change.before}
						columns={columns}
					/>
				</span>
			) : null}
			{change.kind !== 'removed' ? (
				<>
					<span aria-hidden className="text-muted-foreground">
						→
					</span>
					<span>
						<ValueCell
							field={change.field}
							value={change.after}
							columns={columns}
						/>
					</span>
				</>
			) : null}
		</li>
	)
}

export function RevisionHistory({
	snapshots,
	order = 'desc',
	ignore = DEFAULT_IGNORE,
	columns,
	onRestore,
	title = 'Revisions',
	emptyState,
	formatActor = (id) => id,
	formatTimestamp,
	className,
}: RevisionHistoryProps) {
	const revisions = useMemo(
		() => buildRevisions(snapshots, { ignore, order }),
		[snapshots, ignore, order],
	)
	const [restoringId, setRestoringId] = useState<string | null>(null)

	if (revisions.length === 0) {
		return (
			<div className={className}>
				{title ? <h2 className="mb-2 font-semibold text-sm">{title}</h2> : null}
				{emptyState ?? (
					<p className="text-muted-foreground text-sm">No revisions yet.</p>
				)}
			</div>
		)
	}

	return (
		<div className={className}>
			{title ? <h2 className="mb-2 font-semibold text-sm">{title}</h2> : null}
			<ol className="m-0 list-none space-y-4 p-0">
				{revisions.map((rev) => (
					<li
						key={rev.id}
						className="border-border/60 border-b pb-3 last:border-0"
					>
						<div className="flex items-center justify-between gap-2">
							<div className="text-sm">
								{rev.userId ? (
									<span className="font-medium">{formatActor(rev.userId)}</span>
								) : null}{' '}
								<span className="text-muted-foreground">
									{rev.action ?? 'revised'}
								</span>
								<div className="text-muted-foreground text-xs">
									<time dateTime={rev.createdAt}>
										{formatTimestamp ? (
											formatTimestamp(rev.createdAt)
										) : (
											<Timestamp iso={rev.createdAt} />
										)}
									</time>
								</div>
							</div>
							{onRestore && !rev.isFirst ? (
								<button
									type="button"
									disabled={restoringId === rev.id}
									onClick={async () => {
										setRestoringId(rev.id)
										try {
											await onRestore(rev)
										} finally {
											setRestoringId(null)
										}
									}}
									className={cn(
										'rounded-md border border-border px-2 py-1 text-xs hover:bg-muted',
										restoringId === rev.id && 'opacity-50',
									)}
								>
									{restoringId === rev.id ? 'Restoring…' : 'Restore'}
								</button>
							) : null}
						</div>
						{rev.isFirst ? (
							<p className="mt-1 text-muted-foreground text-xs">
								Initial version.
							</p>
						) : rev.diff.length === 0 ? (
							<p className="mt-1 text-muted-foreground text-xs">
								No field changes.
							</p>
						) : (
							<ul className="mt-1 space-y-0.5">
								{rev.diff.map((change) => (
									<DiffRow
										key={change.field}
										change={change}
										columns={columns}
									/>
								))}
							</ul>
						)}
					</li>
				))}
			</ol>
		</div>
	)
}
