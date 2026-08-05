/**
 * `<TreeList>` (Plan v5 task 40) — the hierarchical list variant for a
 * self-referencing resource (`parent_id`). Same introspection + field library as
 * `<ResourceList>`, but rows nest and expand/collapse. The parent column is
 * auto-detected: the single self-reference (a `references.table === resource.name`
 * column), overridable via `parentField`. Expansion is local state (all-expanded
 * by default); a caret toggles a subtree. Cells render through `<Field>` so
 * dates/enums/references present correctly, exactly as in the table.
 */

import { type ReactNode, useMemo, useState } from 'react'
import {
	humanizeLabel,
	type IntrospectedColumn,
} from '../fields/field-semantics.ts'
import { Field } from '../fields/fields.tsx'
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
import { buildTree, flattenTree } from './tree.ts'

/** Find the column that references this same resource (the tree edge). */
export function detectParentField(
	resource: IntrospectedResource,
): string | undefined {
	return resource.columns.find((c) => c.references?.table === resource.name)
		?.name
}

export interface TreeListProps {
	resource: IntrospectedResource
	rows: Row[]
	references?: ReferenceResolution
	columns?: ColumnOverrides
	/** Override the auto-detected self-reference column. */
	parentField?: string
	/** Start with every node collapsed instead of expanded. */
	collapsed?: boolean
	showPrimaryKey?: boolean
	emptyState?: ReactNode
	className?: string
}

interface Col {
	column: IntrospectedColumn
	label: string
	render?: (ctx: {
		value: unknown
		row: Row
		column: IntrospectedColumn
	}) => ReactNode
}

const HEADER_CLASS =
	'border-b border-border px-3 py-2 text-left text-xs font-medium uppercase tracking-wide text-muted-foreground'

export function TreeList({
	resource,
	rows,
	references,
	columns = {},
	parentField,
	collapsed = false,
	showPrimaryKey = false,
	emptyState,
	className,
}: TreeListProps) {
	const pk = resource.primaryKey
	const parent = parentField ?? detectParentField(resource)

	const cols = useMemo<Col[]>(() => {
		const out: Col[] = []
		for (const column of resource.columns) {
			const override = normalizeOverride(columns[column.name])
			const isPk = column.name === pk
			const hidden =
				override.hidden ??
				(column.meta?.hidden === true || (isPk && !showPrimaryKey))
			if (hidden) continue
			out.push({
				column,
				label:
					override.label ?? column.meta?.label ?? humanizeLabel(column.name),
				render: override.render,
			})
		}
		return out
	}, [resource, columns, pk, showPrimaryKey])

	const roots = useMemo(
		() =>
			parent
				? buildTree(rows, { idField: pk, parentField: parent })
				: rows.map((row) => ({ row, children: [], depth: 0 })),
		[rows, pk, parent],
	)

	// All ids expanded by default (unless `collapsed`); toggling flips one id.
	const [overrides, setOverrides] = useState<Record<string, boolean>>({})
	const isExpanded = (id: string) => overrides[id] ?? !collapsed
	const toggle = (id: string) =>
		setOverrides((prev) => ({ ...prev, [id]: !(prev[id] ?? !collapsed) }))

	// Flatten each render (cheap) so the visible rows track `overrides`/`collapsed`
	// without a memo whose dependency list the closure would obscure.
	const visible = flattenTree(roots, { idField: pk, isExpanded })

	if (rows.length === 0) {
		return (
			<div className={className}>
				{emptyState ?? <p className="text-muted-foreground">No records yet.</p>}
			</div>
		)
	}

	return (
		<ReferenceProvider value={references ?? {}}>
			<div
				className={cn(
					'overflow-x-auto rounded-lg border border-border',
					className,
				)}
			>
				<table className="w-full border-collapse">
					<thead>
						<tr className="bg-muted/50">
							{cols.map((c) => (
								<th key={c.column.name} className={HEADER_CLASS}>
									{c.label}
								</th>
							))}
						</tr>
					</thead>
					<tbody>
						{visible.map((node) => {
							const id = String(node.row[pk])
							const hasChildren = node.children.length > 0
							const expanded = isExpanded(id)
							return (
								<tr
									key={id}
									className="hover:bg-muted/30"
									data-depth={node.depth}
								>
									{cols.map((c, ci) => {
										const value = node.row[c.column.name]
										// The first column carries the indent + caret so the
										// hierarchy reads regardless of which columns show.
										const isFirst = ci === 0
										return (
											<td
												key={c.column.name}
												className="border-b border-border/50 px-3 py-2 text-sm"
											>
												<span
													className="inline-flex items-center gap-1"
													style={
														isFirst
															? { paddingLeft: `${node.depth * 1.25}rem` }
															: undefined
													}
												>
													{isFirst && hasChildren ? (
														<button
															type="button"
															aria-label={expanded ? 'Collapse' : 'Expand'}
															aria-expanded={expanded}
															onClick={() => toggle(id)}
															className="text-muted-foreground hover:text-foreground"
														>
															<span aria-hidden>{expanded ? '▾' : '▸'}</span>
														</button>
													) : isFirst ? (
														<span aria-hidden className="inline-block w-3" />
													) : null}
													{c.render ? (
														c.render({ value, row: node.row, column: c.column })
													) : (
														<Field value={value} column={c.column} />
													)}
												</span>
											</td>
										)
									})}
								</tr>
							)
						})}
					</tbody>
				</table>
			</div>
		</ReferenceProvider>
	)
}
