/**
 * Semantic display components — the read-side mirror of DynamicForm's widgets.
 * Each takes a raw value plus the introspected column and renders it the way a
 * mature admin framework would: dates as relative time, emails as mailto links,
 * enums as colored chips, numbers with `prefix`/`suffix`, and so on.
 *
 * `<Field>` is the dispatcher: it runs `detectFieldKind` and delegates. A caller
 * that wants a specific presentation can use a leaf component directly, but the
 * common path — `<ResourceList>` / `<Show>` — always goes through `<Field>`, so
 * a column's display is inferred exactly once, from the same place the form
 * infers its widget.
 */

import type { ReactNode } from 'react'
import { cn } from '../lib/cn.ts'
import { renderMarkdown } from '../markdown.ts'
import {
	detectFieldKind,
	type FieldMetaLike,
	type IntrospectedColumn,
} from './field-semantics.ts'
import { isUrlValue, useResolvedFile } from './file-context.tsx'
import { useReferenceValue } from './reference-context.tsx'

const EMPTY = '—'

function isEmpty(value: unknown): boolean {
	return value === null || value === undefined || value === ''
}

/** Placeholder for null/empty values; shared so every field renders the same dash. */
export function EmptyValue() {
	return <span className="text-muted-foreground">{EMPTY}</span>
}

// --- date -------------------------------------------------------------------

function toDate(value: unknown): Date | null {
	if (value instanceof Date) return Number.isNaN(value.getTime()) ? null : value
	if (typeof value === 'string' || typeof value === 'number') {
		const d = new Date(value)
		return Number.isNaN(d.getTime()) ? null : d
	}
	return null
}

const RELATIVE_UNITS: [Intl.RelativeTimeFormatUnit, number][] = [
	['year', 60 * 60 * 24 * 365],
	['month', 60 * 60 * 24 * 30],
	['week', 60 * 60 * 24 * 7],
	['day', 60 * 60 * 24],
	['hour', 60 * 60],
	['minute', 60],
]

/** "3 days ago" / "in 2 hours" — the default date presentation. `now` is
 * injectable so the output is testable without touching the clock. */
export function relativeTime(date: Date, now: Date = new Date()): string {
	const seconds = Math.round((date.getTime() - now.getTime()) / 1000)
	const abs = Math.abs(seconds)
	if (abs < 45) return 'just now'
	const rtf = new Intl.RelativeTimeFormat('en', { numeric: 'auto' })
	for (const [unit, unitSeconds] of RELATIVE_UNITS) {
		if (abs >= unitSeconds || unit === 'minute') {
			return rtf.format(Math.round(seconds / unitSeconds), unit)
		}
	}
	return 'just now'
}

export interface FieldProps {
	value: unknown
	column?: IntrospectedColumn
	className?: string
}

export function DateField({ value, column, className }: FieldProps) {
	const date = toDate(value)
	if (!date) return <EmptyValue />
	// `format: 'date'` (or any format that isn't relative) shows an absolute
	// ISO date; otherwise the relative default. A full i18n format vocabulary is
	// deliberately out of scope — `format` here just toggles absolute vs relative.
	const format = column?.meta?.format
	const absolute =
		format === 'date' || format === 'datetime' || format === 'iso'
	const text = absolute
		? format === 'datetime' || format === 'iso'
			? date.toISOString().replace('T', ' ').slice(0, 16)
			: date.toISOString().slice(0, 10)
		: relativeTime(date)
	return (
		<time
			dateTime={date.toISOString()}
			title={date.toISOString()}
			className={className}
		>
			{text}
		</time>
	)
}

// --- email / url ------------------------------------------------------------

export function EmailField({ value, className }: FieldProps) {
	if (isEmpty(value)) return <EmptyValue />
	const email = String(value)
	return (
		<a
			href={`mailto:${email}`}
			className={cn('underline-offset-4 hover:underline', className)}
		>
			{email}
		</a>
	)
}

export function UrlField({ value, className }: FieldProps) {
	if (isEmpty(value)) return <EmptyValue />
	const url = String(value)
	// Show the bare host as the link text (an admin table wants a compact cell),
	// but fall back to the raw string when it doesn't parse as a URL.
	let text = url
	try {
		text = new URL(url).host || url
	} catch {
		/* keep raw */
	}
	return (
		<a
			href={url}
			target="_blank"
			rel="noreferrer noopener"
			className={cn('underline-offset-4 hover:underline', className)}
			title={url}
		>
			{text}
		</a>
	)
}

// --- boolean ----------------------------------------------------------------

export function BooleanField({ value, className }: FieldProps) {
	if (value === null || value === undefined) return <EmptyValue />
	const on = value === true || value === 'true' || value === 'on'
	return (
		<span
			role="img"
			aria-label={on ? 'yes' : 'no'}
			className={cn(
				// Semantic, unlike the enum tints below: a boolean has exactly two
				// states and "true" is the affirmative one.
				on ? 'text-success' : 'text-muted-foreground',
				className,
			)}
		>
			{on ? '✓' : '✗'}
		</span>
	)
}

// --- enum -------------------------------------------------------------------

/**
 * Deterministic chip tint from the value, so the same enum value is always the
 * same color without needing a per-option palette in the spec.
 *
 * These stay literal Tailwind palette colours, deliberately, while the rest of
 * this package runs on theme tokens. The job here is **categorical**, not
 * semantic: six tints that a reader can tell apart at a glance, meaning nothing
 * individually. Theme tokens are the wrong tool — there are only three status
 * colours and they each carry a meaning ("this failed") that an arbitrary enum
 * value has no business borrowing. A `status: shipped` chip painted
 * `--destructive` because the hash landed there would be worse than any drift
 * from the preset.
 */
const CHIP_TINTS = [
	'bg-blue-100 text-blue-800 dark:bg-blue-900/40 dark:text-blue-200',
	'bg-emerald-100 text-emerald-800 dark:bg-emerald-900/40 dark:text-emerald-200',
	'bg-amber-100 text-amber-800 dark:bg-amber-900/40 dark:text-amber-200',
	'bg-violet-100 text-violet-800 dark:bg-violet-900/40 dark:text-violet-200',
	'bg-rose-100 text-rose-800 dark:bg-rose-900/40 dark:text-rose-200',
	'bg-cyan-100 text-cyan-800 dark:bg-cyan-900/40 dark:text-cyan-200',
]

function tintFor(value: string): string {
	let hash = 0
	for (let i = 0; i < value.length; i++)
		hash = (hash * 31 + value.charCodeAt(i)) | 0
	const idx = Math.abs(hash) % CHIP_TINTS.length
	return CHIP_TINTS[idx] as string
}

/** Resolve an option's display label from metadata (falls back to the raw value). */
function optionLabel(value: string, meta?: FieldMetaLike): string {
	const opt = meta?.options?.find((o) => o.value === value)
	return opt?.label ?? value
}

export function EnumChip({ value, column, className }: FieldProps) {
	if (isEmpty(value)) return <EmptyValue />
	const raw = String(value)
	const label = optionLabel(raw, column?.meta)
	return (
		<span
			className={cn(
				'inline-flex items-center rounded-full px-2 py-0.5 text-xs font-medium',
				tintFor(raw),
				className,
			)}
		>
			{label}
		</span>
	)
}

// --- number -----------------------------------------------------------------

/**
 * Thousands grouping, at a **fixed** locale. `toLocaleString()` with no
 * argument resolves the locale from the runtime, so the server and the browser
 * can disagree and the render hydrates differently (the #138 / #267 class).
 */
function grouped(n: number): string {
	return new Intl.NumberFormat('en').format(n)
}

/** The same fixed-locale formatter with the separators off — this keeps the
 * fraction-digit rounding, so a float that arrives as `0.30000000000000004`
 * still reads as `0.3` rather than spilling its binary residue. */
function plain(n: number): string {
	return new Intl.NumberFormat('en', { useGrouping: false }).format(n)
}

/**
 * Numbers render **plain by default** — `2019` is a vintage, a year, a port, a
 * street number or a model number far more often than it is a quantity worth
 * grouping, and `2,019` is actively wrong for every one of those.
 * The spec's six canonical types cannot tell those apart, so the default is the
 * reading that is never wrong, only occasionally less pretty. Grouping is
 * available on request: `meta.format` of `grouped`, `currency` or `percent`.
 */
export function NumberField({ value, column, className }: FieldProps) {
	if (isEmpty(value)) return <EmptyValue />
	const num = typeof value === 'number' ? value : Number(value)
	if (Number.isNaN(num)) return <>{String(value)}</>
	const meta = column?.meta
	const format = meta?.format
	let text: string
	if (format === 'percent') {
		text = `${grouped(num * 100)}%`
	} else if (format === 'currency') {
		text = new Intl.NumberFormat('en', {
			style: 'currency',
			currency: 'USD',
		}).format(num)
	} else if (format === 'grouped') {
		text = grouped(num)
	} else {
		text = plain(num)
	}
	if (format !== 'currency') {
		if (meta?.prefix) text = `${meta.prefix}${text}`
		if (meta?.suffix) text = `${text}${meta.suffix}`
	}
	return <span className={cn('tabular-nums', className)}>{text}</span>
}

// --- markdown ---------------------------------------------------------------

export function MarkdownField({ value, className }: FieldProps) {
	if (isEmpty(value)) return <EmptyValue />
	return (
		<div
			className={cn('prose prose-sm max-w-none', className)}
			// biome-ignore lint/security/noDangerouslySetInnerHtml: input is escaped in renderMarkdown before any tag is emitted
			dangerouslySetInnerHTML={{ __html: renderMarkdown(String(value)) }}
		/>
	)
}

// --- image / file -----------------------------------------------------------

/** Whether a string plausibly addresses an image: a URL, a data/blob URI, a
 * path, or a filename with an image extension. Image-ness is often inferred
 * from the column *name* alone, and a name-matched column can hold plain text
 * (an emoji in an `icon` field) that must not become a broken `<img>`
 *. */
export function looksLikeImageSrc(src: string): boolean {
	return (
		/^(https?:\/\/|data:image\/|blob:)/i.test(src) ||
		/^(\/|\.{1,2}\/)/.test(src) ||
		/\.(png|jpe?g|gif|webp|svg|avif|bmp|ico)([?#]|$)/i.test(src)
	)
}

/**
 * A stored image. The column holds a storage key, so the src comes from the
 * loader-resolved `<FileProvider>` map — a key we cannot resolve
 * renders as text, never as a broken `<img>`.
 *
 * When the field declares a `thumb` derivative and the loader resolved it, the
 * thumbnail is used here: rendering a full-size original into a 40px box is the
 * exact waste declared derivatives exist to remove.
 */
export function ImageField({ value, column, className }: FieldProps) {
	const resolved = useResolvedFile(value)
	if (isEmpty(value)) return <EmptyValue />
	const src = resolved?.url ?? (isUrlValue(String(value)) ? String(value) : '')
	if (!src || !looksLikeImageSrc(src)) {
		return <TextField value={value} column={column} className={className} />
	}
	return (
		<img
			src={resolved?.derivatives?.thumb ?? src}
			alt={column?.meta?.label ?? column?.name ?? ''}
			className={cn('h-10 w-10 rounded object-cover', className)}
		/>
	)
}

/**
 * A stored file, as a link to the read gateway. The href is the loader's
 * freshly signed, viewer-bound URL; an unresolved key shows as plain text
 * rather than a link that would 403 on click.
 */
export function FileField({ value, className }: FieldProps) {
	const resolved = useResolvedFile(value)
	if (isEmpty(value)) return <EmptyValue />
	const raw = String(value)
	if (!resolved) {
		return <span className={cn('text-muted-foreground', className)}>{raw}</span>
	}
	const name = resolved.name ?? raw.split('/').pop() ?? raw
	return (
		<a
			href={resolved.url}
			target="_blank"
			rel="noreferrer noopener"
			className={cn('underline-offset-4 hover:underline', className)}
		>
			{name}
		</a>
	)
}

// --- rich text (HTML) -------------------------------------------------------

/** Rich text stored as HTML (the read dual of `<FormRichTextEditor>`). The value
 * is HTML the editor produced; render it inside a `prose` block. */
export function RichTextField({ value, className }: FieldProps) {
	if (isEmpty(value)) return <EmptyValue />
	return (
		<div
			className={cn('prose prose-sm max-w-none', className)}
			// biome-ignore lint/security/noDangerouslySetInnerHtml: rich-text values are first-party admin content produced by the bundled editor
			dangerouslySetInnerHTML={{ __html: String(value) }}
		/>
	)
}

// --- color ------------------------------------------------------------------

export function ColorField({ value, className }: FieldProps) {
	if (isEmpty(value)) return <EmptyValue />
	const color = String(value)
	return (
		<span className={cn('inline-flex items-center gap-1.5', className)}>
			<span
				aria-hidden
				className="inline-block size-4 rounded border border-input"
				style={{ backgroundColor: color }}
			/>
			<code className="text-xs tabular-nums">{color}</code>
		</span>
	)
}

// --- rating -----------------------------------------------------------------

export function RatingField({ value, column, className }: FieldProps) {
	if (isEmpty(value)) return <EmptyValue />
	const num = typeof value === 'number' ? value : Number(value)
	if (Number.isNaN(num)) return <>{String(value)}</>
	const max = ratingMax(column?.meta)
	// The *stars* are clamped because there are only `max` of them to draw. The
	// *value* is not, and the two must not be conflated (#345): a row storing 8
	// on a 5-point scale used to announce as "5 out of 5" and render pixel-identical
	// to a genuine 5, so the accessible name stated something the data does not.
	// The label always carries the stored number, and an out-of-range value is
	// also written out visibly — a hover-only `title` is unavailable on touch and
	// to exactly the users the `aria-label` exists for.
	const filled = Math.max(0, Math.min(max, Math.round(num)))
	const outOfRange = num < 0 || num > max
	return (
		<span className={cn('inline-flex items-baseline gap-1', className)}>
			<span
				role="img"
				// A rating star is gold by convention, the way a warning sign is
				// yellow — it is not the theme's `warning`, which means "something
				// needs attention" and would make five stars read as five problems.
				className="tabular-nums text-amber-500"
				aria-label={`${num} out of ${max}`}
			>
				{'★'.repeat(filled)}
				<span className="text-muted-foreground">
					{'☆'.repeat(max - filled)}
				</span>
			</span>
			{outOfRange ? (
				<span className="text-muted-foreground text-xs tabular-nums">
					{num} / {max}
				</span>
			) : null}
		</span>
	)
}

/** A rating's upper bound: `meta.max` if given, else a 5-star default. */
export function ratingMax(meta?: FieldMetaLike): number {
	const max = meta?.max
	return typeof max === 'number' && max > 0 ? max : 5
}

// --- duration ---------------------------------------------------------------

/** Humanize a count of seconds as `1h 2m 3s` (the read dual of the duration
 * editor, which stores seconds). Zero-valued leading units are dropped. */
export function formatDuration(totalSeconds: number): string {
	const s = Math.max(0, Math.round(totalSeconds))
	const h = Math.floor(s / 3600)
	const m = Math.floor((s % 3600) / 60)
	const sec = s % 60
	const parts: string[] = []
	if (h) parts.push(`${h}h`)
	if (m) parts.push(`${m}m`)
	if (sec || parts.length === 0) parts.push(`${sec}s`)
	return parts.join(' ')
}

export function DurationField({ value, className }: FieldProps) {
	if (isEmpty(value)) return <EmptyValue />
	const num = typeof value === 'number' ? value : Number(value)
	if (Number.isNaN(num)) return <>{String(value)}</>
	return (
		<span className={cn('tabular-nums', className)}>{formatDuration(num)}</span>
	)
}

// --- geo / coordinates ------------------------------------------------------

/** Parse a `"lat,lng"` string (or a `{lat,lng}` object) into a pair, or null. */
export function parseLatLng(
	value: unknown,
): { lat: number; lng: number } | null {
	if (value && typeof value === 'object') {
		const o = value as { lat?: unknown; lng?: unknown; lon?: unknown }
		const lat = Number(o.lat)
		const lng = Number(o.lng ?? o.lon)
		if (!Number.isNaN(lat) && !Number.isNaN(lng)) return { lat, lng }
		return null
	}
	const parts = String(value).split(',')
	if (parts.length !== 2) return null
	const lat = Number(parts[0])
	const lng = Number(parts[1])
	if (Number.isNaN(lat) || Number.isNaN(lng)) return null
	return { lat, lng }
}

export function GeoField({ value, className }: FieldProps) {
	if (isEmpty(value)) return <EmptyValue />
	const pair = parseLatLng(value)
	if (!pair) return <TextField value={value} className={className} />
	const text = `${pair.lat.toFixed(5)}, ${pair.lng.toFixed(5)}`
	return (
		<a
			href={`https://www.openstreetmap.org/?mlat=${pair.lat}&mlon=${pair.lng}#map=12/${pair.lat}/${pair.lng}`}
			target="_blank"
			rel="noreferrer noopener"
			className={cn(
				'tabular-nums underline-offset-4 hover:underline',
				className,
			)}
			title="Open in map"
		>
			{text}
		</a>
	)
}

// --- json -------------------------------------------------------------------

export function JsonField({ value, className }: FieldProps) {
	if (value === null || value === undefined || value === '')
		return <EmptyValue />
	let text: string
	try {
		text =
			typeof value === 'string'
				? JSON.stringify(JSON.parse(value), null, 2)
				: JSON.stringify(value, null, 2)
	} catch {
		text = String(value)
	}
	return (
		<pre
			className={cn(
				'max-h-40 overflow-auto rounded-md border border-input bg-muted/40 p-2 text-xs',
				className,
			)}
		>
			<code>{text}</code>
		</pre>
	)
}

// --- password ---------------------------------------------------------------

/** A secret is never shown in a read view — render a fixed mask. */
export function PasswordField({ value, className }: FieldProps) {
	if (isEmpty(value)) return <EmptyValue />
	return <span className={cn('tracking-widest', className)}>••••••••</span>
}

// --- reference --------------------------------------------------------------

/**
 * An FK rendered as the referenced record's display value, resolved from the
 * `<ReferenceProvider>` context a loader populated (batched, no N+1). Falls back
 * to the raw id when unresolved, so it never shows nothing. With `linkComponent`
 * + `hrefFor` the value links to the referenced record's detail page.
 */
export function ReferenceField({
	value,
	column,
	className,
	linkComponent: Link,
	hrefFor,
}: FieldProps & {
	linkComponent?: (props: {
		to: string
		children: ReactNode
		className?: string
	}) => ReactNode
	hrefFor?: (ctx: { table: string; id: string }) => string
}) {
	const table = column?.references?.table
	const id = value === null || value === undefined ? undefined : String(value)
	const resolved = useReferenceValue(table, id)
	if (isEmpty(value)) return <EmptyValue />
	const text = resolved ?? id ?? EMPTY
	if (Link && hrefFor && table && id !== undefined) {
		return (
			<Link
				to={hrefFor({ table, id })}
				className={cn('underline-offset-4 hover:underline', className)}
			>
				{text}
			</Link>
		)
	}
	return <span className={className}>{text}</span>
}

// --- reference array (the "many" side) --------------------------------------

/** Parse an array-reference cell into id strings — a real array (drizzle `json`)
 * or a JSON string that crossed a wire; blanks dropped, junk → `[]`. */
export function parseReferenceIds(value: unknown): string[] {
	let arr: unknown = value
	if (typeof value === 'string') {
		const trimmed = value.trim()
		if (trimmed === '') return []
		try {
			arr = JSON.parse(trimmed)
		} catch {
			return []
		}
	}
	if (!Array.isArray(arr)) return []
	return arr
		.filter((v) => v !== null && v !== undefined && v !== '')
		.map((v) => String(v))
}

/** One resolved chip — a leaf so the resolution hook is called once per id at a
 * stable position (rules-of-hooks safe as the id list changes). */
function ReferenceChip({
	table,
	id,
	linkComponent: Link,
	hrefFor,
}: {
	table?: string
	id: string
	linkComponent?: (props: {
		to: string
		children: ReactNode
		className?: string
	}) => ReactNode
	hrefFor?: (ctx: { table: string; id: string }) => string
}) {
	const resolved = useReferenceValue(table, id)
	const text = resolved ?? id
	const chip =
		'inline-flex items-center rounded-full border border-input bg-secondary px-2 py-0.5 text-xs text-secondary-foreground'
	if (Link && hrefFor && table) {
		return (
			<Link to={hrefFor({ table, id })} className={cn(chip, 'hover:bg-accent')}>
				{text}
			</Link>
		)
	}
	return <span className={chip}>{text}</span>
}

/**
 * An array of FKs (`article.tags`) rendered as chips, each resolved to its
 * referenced record's display value from the same `<ReferenceProvider>` context
 * a single `<ReferenceField>` uses — one batched `getMany` per table, no N+1
 * (Plan v5 task 38). Unresolved ids fall back to the raw id, so it never blanks.
 */
export function ReferenceArrayField({
	value,
	column,
	className,
	linkComponent,
	hrefFor,
}: FieldProps & {
	linkComponent?: (props: {
		to: string
		children: ReactNode
		className?: string
	}) => ReactNode
	hrefFor?: (ctx: { table: string; id: string }) => string
}) {
	const table = column?.meta?.arrayReference?.table
	const ids = parseReferenceIds(value)
	if (ids.length === 0) return <EmptyValue />
	return (
		<span className={cn('inline-flex flex-wrap gap-1', className)}>
			{ids.map((id) => (
				<ReferenceChip
					key={id}
					table={table}
					id={id}
					linkComponent={linkComponent}
					hrefFor={hrefFor}
				/>
			))}
		</span>
	)
}

// --- text (fallback) --------------------------------------------------------

export function TextField({ value, className }: FieldProps) {
	if (isEmpty(value)) return <EmptyValue />
	if (typeof value === 'object') {
		return (
			<code className={cn('text-xs', className)}>{JSON.stringify(value)}</code>
		)
	}
	return <span className={className}>{String(value)}</span>
}

// --- dispatcher -------------------------------------------------------------

/**
 * Render `value` with the component inferred from `column`. With no column (a
 * bare value) it falls back to text — so it is always safe to use.
 */
export function Field({ value, column, className }: FieldProps): ReactNode {
	const kind = column ? detectFieldKind(column) : 'text'
	const props = { value, column, className }
	switch (kind) {
		case 'date':
			return <DateField {...props} />
		case 'email':
			return <EmailField {...props} />
		case 'url':
			return <UrlField {...props} />
		case 'boolean':
			return <BooleanField {...props} />
		case 'enum':
			return <EnumChip {...props} />
		case 'number':
			return <NumberField {...props} />
		case 'markdown':
			return <MarkdownField {...props} />
		case 'richtext':
			return <RichTextField {...props} />
		case 'image':
			return <ImageField {...props} />
		case 'file':
			return <FileField {...props} />
		case 'color':
			return <ColorField {...props} />
		case 'rating':
			return <RatingField {...props} />
		case 'duration':
			return <DurationField {...props} />
		case 'geo':
			return <GeoField {...props} />
		case 'json':
			return <JsonField {...props} />
		case 'password':
			return <PasswordField {...props} />
		case 'reference':
			return <ReferenceField {...props} />
		case 'reference-array':
			return <ReferenceArrayField {...props} />
		default:
			return <TextField {...props} />
	}
}
