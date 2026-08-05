/**
 * **Typed props for block-level slots**.
 *
 * A page-level `<Slot>` is called with whatever the generated page threads into
 * it. A *block* slot replaces one region of a derived surface, so it needs the
 * same field knowledge the generated renderer has — otherwise a slot author
 * re-derives labels, formats, enum members and FK display values from raw row
 * objects, and "bespoke UI" quietly means "re-implement the field library".
 * That is the difference between a slot fill (weight 3) and an eject (weight
 * 5): the platform hands over the *rendering* and keeps the *derivation*.
 *
 * Every `column` here is an {@link IntrospectedColumn}, whose `meta` is exactly
 * what `withMeta` attached in the schema — labels, formats, `options` for
 * enums, `reference` targets, `hidden`. So a bespoke exercise card can read
 * `columns.find(c => c.name === 'videoUrl')?.meta.fileAccept` instead of
 * guessing.
 *
 * These types are structural and dependency-free on purpose: the ids that name
 * them live in `@maxstack/core`'s ownership layer, the shapes live here with
 * the components that supply them, and neither imports the other.
 */

import type { ReactNode } from 'react'
import type { IntrospectedColumn } from '../fields/field-semantics.ts'
import type { FileResolution } from '../fields/file-context.tsx'
import type { ReferenceResolution } from '../fields/reference-context.tsx'
import type { IntrospectedResource, Row } from '../resource/resource-types.ts'

/** What every block slot on a resource page is given, whatever its role. */
export interface BlockSlotBaseProps {
	/** The introspected resource — `columns` carry their `withMeta` metadata. */
	resource: IntrospectedResource
	/** The columns this page renders, in order, after the spec field selection. */
	columns: IntrospectedColumn[]
}

/** `<resource>__header` — the page header region. */
export interface HeaderSlotProps extends BlockSlotBaseProps {
	/** The page heading the spec declares. */
	title: string
	/** Href of the generated "new record" action, so a bespoke header keeps it. */
	newHref: string
}

/**
 * `<resource>__list` — the whole list region. The bespoke-UI escape hatch that
 * does *not* cost an eject: rows arrive loaded, ordered by the spec's `order`,
 * with FK titles and signed file URLs already resolved, and the page frame,
 * nav, header and routing keep regenerating around it.
 */
export interface ListSlotProps extends BlockSlotBaseProps {
	rows: Row[]
	/** Batch-resolved FK display values, keyed as the field library expects. */
	references: ReferenceResolution
	/** Loader-resolved signed URLs for file columns, keyed by storage key. */
	files: FileResolution
	/** The detail/edit href for a row — keeps bespoke rows linked into CRUD. */
	rowHref: (row: Row) => string
	/** Rendered when `rows` is empty, unless the `empty` slot is filled too. */
	emptyState: ReactNode
}

/** `<resource>__row` — one row/card/entry inside the generated list. */
export interface RowSlotProps extends BlockSlotBaseProps {
	row: Row
	/** The row's detail/edit href. */
	href: string
	/** True when this row came from `maxstack demo`. */
	isDemo: boolean
}

/** `<resource>__field__<name>` — one field's cell, everywhere it renders. */
export interface FieldSlotProps {
	/** The cell value, as it came out of the store. */
	value: unknown
	/** The whole row, for a cell that needs a sibling field. */
	row: Row
	/** This field's column, including its `withMeta` metadata. */
	column: IntrospectedColumn
}

/** `<resource>__empty` — the empty state for a resource with no rows. */
export interface EmptySlotProps extends BlockSlotBaseProps {
	/** Href of the "new record" action. */
	newHref: string
	/** True when a bundle has sample rows this project could seed. */
	demoAvailable: boolean
}
