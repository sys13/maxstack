/**
 * `<Show>` / `<RecordDetail>` — a read-only record view inferred from Sprout
 * introspection: the display dual of an edit form (Plan v5 task 31). Every
 * field renders through the semantic field library as a label/value pair.
 *
 * Unlike DynamicForm — which omits `readOnly` columns from an editable form —
 * `<Show>` renders them: read-only is exactly what a detail view is for. `hidden`
 * columns are still skipped; the primary key shows by default (an id is useful
 * on a detail page, unlike in a list).
 *
 * The same eject seam as `<ResourceList>`: any field is overridable through the
 * `fields` prop (`fields={{ author: MyField }}`), which a slot can supply.
 */

import type { ReactNode } from 'react'
import { humanizeLabel } from '../fields/field-semantics.ts'
import { Field } from '../fields/fields.tsx'
import { FileProvider, type FileResolution } from '../fields/file-context.tsx'
import {
	ReferenceProvider,
	type ReferenceResolution,
} from '../fields/reference-context.tsx'
import { cn } from '../lib/cn.ts'
import {
	type ColumnOverrides,
	type IntrospectedResource,
	normalizeOverride,
	type Row,
} from './resource-types.ts'

export interface ShowProps {
	resource: IntrospectedResource
	record: Row
	/** Batch-resolved FK display values (core's `resolveReferences`). */
	references?: ReferenceResolution
	/** Loader-resolved signed URLs for this page's file columns, keyed by storage
	 * key. A file column stores a key; only the server can sign it. */
	files?: FileResolution
	/** Per-field renderer/label overrides — the eject seam. */
	fields?: ColumnOverrides
	/** Hide the primary key (shown by default on a detail view). */
	hidePrimaryKey?: boolean
	className?: string
}

export function Show({
	resource,
	record,
	references,
	files,
	fields = {},
	hidePrimaryKey = false,
	className,
}: ShowProps): ReactNode {
	const rows = resource.columns.filter((column) => {
		const override = normalizeOverride(fields[column.name])
		const isPk = column.name === resource.primaryKey
		return !(
			override.hidden ??
			(column.meta?.hidden === true || (isPk && hidePrimaryKey))
		)
	})

	return (
		<ReferenceProvider value={references ?? {}}>
			<FileProvider value={files ?? {}}>
				<dl
					className={cn(
						'grid grid-cols-[minmax(8rem,max-content)_1fr] gap-x-6 gap-y-3',
						className,
					)}
				>
					{rows.map((column) => {
						const override = normalizeOverride(fields[column.name])
						const label =
							override.label ?? column.meta?.label ?? humanizeLabel(column.name)
						const value = record[column.name]
						return (
							<div key={column.name} className="contents">
								<dt className="text-sm font-medium text-muted-foreground">
									{label}
								</dt>
								<dd className="text-sm">
									{override.render ? (
										override.render({ value, row: record, column })
									) : (
										<Field value={value} column={column} />
									)}
								</dd>
							</div>
						)
					})}
				</dl>
			</FileProvider>
		</ReferenceProvider>
	)
}

export { Show as RecordDetail }
