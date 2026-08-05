/**
 * Rich & specialty form controls (Plan v5 task 39) — the editing duals of the
 * task-31/39 display fields, all dependency-light and Conform-bridged.
 *
 * Bridge pattern (same as `ui/form-fields.tsx`): `useControl` owns the submitted
 * value; a single hidden `<input name>` is registered via `ref={control.register}`
 * so exactly one value submits per field, and the visible custom UI drives
 * `control.change`. This keeps every widget a drop-in for the native `<Input>` it
 * replaces — DynamicForm swaps the control, nothing else changes.
 *
 * These are deliberately dependency-light: the rich-text editor is a
 * `contentEditable` region with a tiny `execCommand` toolbar, and markdown
 * reuses the same `renderMarkdown` the read field uses so the live preview
 * matches the rendered field by construction. The uploader (task 60) is the
 * one control with a real backend dependency: picked files are POSTed to an
 * upload endpoint (`/api/upload` by default) and the submitted value is the
 * storage **key** the endpoint returns — not an embedded `data:` payload, and
 * not the signed URL (which expires). The read path re-signs the
 * key on every render.
 */

import { useId, useRef, useState } from 'react'
import { cn } from '../lib/cn.ts'
import { renderMarkdown } from '../markdown.ts'
import { useControlValue } from './use-control-value.ts'

interface BaseProps {
	id?: string
	name: string
	defaultValue?: string
	ariaDescribedBy?: string
	className?: string
	disabled?: boolean
	placeholder?: string
}

const inputClass =
	'flex h-9 w-full rounded-md border border-input bg-transparent px-3 py-1 text-sm shadow-sm focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring disabled:cursor-not-allowed disabled:opacity-50'
const areaClass =
	'flex min-h-32 w-full rounded-md border border-input bg-transparent px-3 py-2 text-sm shadow-sm focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring disabled:cursor-not-allowed disabled:opacity-50'

// --- markdown editor --------------------------------------------------------

/** Textarea + live preview toggle. Stores the raw markdown text; the Preview tab
 * renders it with the same `renderMarkdown` `<MarkdownField>` uses. */
export function FormMarkdownEditor({
	id,
	name,
	defaultValue = '',
	ariaDescribedBy,
	className,
	disabled,
	placeholder,
}: BaseProps) {
	const [value, setValue, register] = useControlValue(defaultValue)
	const [tab, setTab] = useState<'write' | 'preview'>('write')
	return (
		<div className={cn('space-y-2', className)}>
			<input type="hidden" name={name} ref={register} />
			<div role="tablist" className="flex gap-1 text-xs">
				{(['write', 'preview'] as const).map((t) => (
					<button
						key={t}
						type="button"
						role="tab"
						aria-selected={tab === t}
						onClick={() => setTab(t)}
						className={cn(
							'rounded px-2 py-1 capitalize',
							tab === t
								? 'bg-accent font-medium text-foreground'
								: 'text-muted-foreground hover:text-foreground',
						)}
					>
						{t}
					</button>
				))}
			</div>
			{tab === 'write' ? (
				<textarea
					id={id}
					value={value}
					disabled={disabled}
					placeholder={placeholder ?? 'Write markdown…'}
					aria-describedby={ariaDescribedBy}
					onChange={(e) => setValue(e.currentTarget.value)}
					className={cn(areaClass, 'font-mono')}
				/>
			) : (
				<div
					// biome-ignore lint/security/noDangerouslySetInnerHtml: renderMarkdown escapes input before emitting any tag
					dangerouslySetInnerHTML={{ __html: renderMarkdown(value) }}
					className="prose prose-sm min-h-32 max-w-none rounded-md border border-input p-3"
				/>
			)}
		</div>
	)
}

// --- rich text (HTML) editor ------------------------------------------------

const RICH_COMMANDS: { cmd: string; label: string; title: string }[] = [
	{ cmd: 'bold', label: 'B', title: 'Bold' },
	{ cmd: 'italic', label: 'I', title: 'Italic' },
	{ cmd: 'insertUnorderedList', label: '• List', title: 'Bulleted list' },
]

/** A `contentEditable` region with a minimal formatting toolbar. Stores HTML;
 * the read dual is `<RichTextField>`. Uses `document.execCommand` — deprecated
 * but universally supported and the only fully dependency-free way to get
 * WYSIWYG editing without shipping an editor framework. */
export function FormRichTextEditor({
	id,
	name,
	defaultValue = '',
	ariaDescribedBy,
	className,
	disabled,
}: BaseProps) {
	const [value, setValue, register] = useControlValue(defaultValue)
	const editorRef = useRef<HTMLDivElement>(null)
	// Seed the editable region once from the initial value; thereafter the DOM is
	// the source of truth (re-writing innerHTML on every render would reset the
	// caret). A ref callback runs after mount with the element in hand.
	const seed = (el: HTMLDivElement | null) => {
		if (el && el.innerHTML === '' && defaultValue) el.innerHTML = defaultValue
		editorRef.current = el
	}
	const exec = (cmd: string) => {
		editorRef.current?.focus()
		document.execCommand(cmd)
		if (editorRef.current) setValue(editorRef.current.innerHTML)
	}
	return (
		<div className={cn('space-y-2', className)}>
			<input type="hidden" name={name} ref={register} />
			<div className="flex gap-1">
				{RICH_COMMANDS.map((c) => (
					<button
						key={c.cmd}
						type="button"
						title={c.title}
						disabled={disabled}
						onMouseDown={(e) => e.preventDefault()}
						onClick={() => exec(c.cmd)}
						className="rounded border border-input px-2 py-1 text-xs font-medium hover:bg-accent"
					>
						{c.label}
					</button>
				))}
			</div>
			{/* biome-ignore lint/a11y/useFocusableInteractive: contentEditable elements are natively focusable */}
			{/* biome-ignore lint/a11y/useSemanticElements: a WYSIWYG surface must be a contentEditable div, not a textarea */}
			<div
				id={id}
				ref={seed}
				role="textbox"
				aria-multiline="true"
				aria-describedby={ariaDescribedBy}
				contentEditable={!disabled}
				suppressContentEditableWarning
				onInput={(e) => setValue(e.currentTarget.innerHTML)}
				className={cn(areaClass, 'prose prose-sm max-w-none')}
			/>
			<span className="sr-only" data-testid="richtext-value">
				{value}
			</span>
		</div>
	)
}

// --- file / image upload ----------------------------------------------------

interface UploadedFile {
	name: string
	/** A short-lived, viewer-bound URL for previewing this object right now.
	 * Display only — it is deliberately *not* what gets submitted. */
	url: string
	/** The storage provider's key for this object — the value the form submits
	 * and the column stores. Absent only for a legacy value that
	 * predates real uploads (a raw URL / `data:` string), which round-trips
	 * unchanged rather than being rewritten. */
	key?: string
}

/** What a file field submits for one upload: its storage key when we have one,
 * else the legacy raw value so an old row survives an edit untouched.
 *
 * Storing the key rather than the URL is the fix that makes expiring reads
 * workable at all: a signed URL persisted into a column is a value that stops
 * working, and the row has no way to know. A key is stable forever and the read
 * path re-signs it on every render. */
function submittedValue(file: UploadedFile): string {
	return file.key ?? file.url
}

/**
 * POST one file to the upload endpoint (task 60's `/api/upload` by default)
 * as `multipart/form-data` and return the stored key + a signed/public URL.
 * Throws with the server's error message (or a generic one) on failure, so
 * callers can surface it next to the widget.
 */
async function uploadFile(
	file: File,
	uploadUrl: string,
	target?: { resource?: string; field?: string },
): Promise<UploadedFile> {
	const body = new FormData()
	body.append('file', file)
	// Names the declared field this upload is for, so the server can look up its
	// allowlist and size cap and enforce *those*. These identify the
	// declaration; they never supply it, so nothing here can widen a limit.
	if (target?.resource) body.append('resource', target.resource)
	if (target?.field) body.append('field', target.field)
	const res = await fetch(uploadUrl, { method: 'POST', body })
	if (!res.ok) {
		let message = `Upload of "${file.name}" failed (HTTP ${res.status})`
		try {
			const problem = (await res.json()) as { error?: string }
			if (problem?.error) message = problem.error
		} catch {
			/* non-JSON error body; keep the generic message */
		}
		throw new Error(message)
	}
	const stored = (await res.json()) as {
		key: string
		url: string
		name?: string
	}
	return { name: stored.name ?? file.name, url: stored.url, key: stored.key }
}

/**
 * Drag-and-drop file/image uploader with preview. Selected files are POSTed
 * to `uploadUrl` (`/api/upload` by default) as they're picked; the field's
 * submitted value is the returned storage **key**(s), so the form submit stays
 * small regardless of file size and the stored value never expires.
 * `multiple` stores a JSON array of keys, single stores the one key.
 * `image` renders thumbnails, otherwise filename chips. Honors `accept` /
 * `maxSize` (checked client-side before upload; the server re-checks too).
 */
export function FormFileInput({
	id,
	name,
	defaultValue = '',
	ariaDescribedBy,
	className,
	disabled,
	accept,
	multiple = false,
	image = false,
	maxSize,
	resource,
	previewUrl,
	uploadUrl = '/api/upload',
}: BaseProps & {
	accept?: string
	multiple?: boolean
	image?: boolean
	/** Max per-file size in bytes; a larger file is rejected with a message. */
	maxSize?: number
	/** The resource this field belongs to, sent with the upload so the server can
	 * find the field's declared allowlist and cap. */
	resource?: string
	/** Turn a stored key from `defaultValue` into a previewable URL. Supplied by
	 * the server-rendered form, which alone can mint a viewer-bound signed URL —
	 * without it a stored key renders as a chip with no thumbnail, which is the
	 * correct degradation rather than a broken `<img>`. */
	previewUrl?: (key: string) => string
	/** Where selected files are POSTed as `multipart/form-data`; the response
	 * is expected to be `{ key, url, name? }`. Defaults to the task-60 upload
	 * endpoint apps built on this library ship at `/api/upload`. */
	uploadUrl?: string
}) {
	const [_value, setValue, register] = useControlValue(defaultValue)
	const [error, setError] = useState<string | null>(null)
	const [dragging, setDragging] = useState(false)
	const [uploading, setUploading] = useState(false)
	const inputRef = useRef<HTMLInputElement>(null)
	// Local state is the display source of truth so a freshly-picked file keeps
	// its name while it uploads; the submitted value (via `commit`) is just the
	// URL(s) returned by the upload endpoint.
	const [files, setFiles] = useState<UploadedFile[]>(() =>
		parseFiles(defaultValue, previewUrl),
	)

	const commit = (next: UploadedFile[]) => {
		setFiles(next)
		setValue(
			multiple
				? JSON.stringify(next.map(submittedValue))
				: next[0]
					? submittedValue(next[0])
					: '',
		)
	}

	async function addFiles(list: FileList | null) {
		if (!list || list.length === 0) return
		setError(null)
		const picked = Array.from(list)
		for (const f of picked) {
			if (maxSize && f.size > maxSize) {
				setError(`${f.name} exceeds the ${Math.round(maxSize / 1024)}KB limit`)
				return
			}
		}
		setUploading(true)
		try {
			const uploaded = await Promise.all(
				picked.map((f) => uploadFile(f, uploadUrl, { resource, field: name })),
			)
			commit(multiple ? [...files, ...uploaded] : uploaded.slice(0, 1))
		} catch (e) {
			setError(e instanceof Error ? e.message : 'Upload failed')
		} finally {
			setUploading(false)
		}
	}

	const remove = (index: number) => commit(files.filter((_, i) => i !== index))
	const busy = disabled || uploading

	return (
		<div className={cn('space-y-2', className)}>
			<input type="hidden" name={name} ref={register} />
			{/* biome-ignore lint/a11y/noStaticElementInteractions: the drop zone wraps a real file <input> that carries the semantics */}
			<div
				onDragOver={(e) => {
					e.preventDefault()
					setDragging(true)
				}}
				onDragLeave={() => setDragging(false)}
				onDrop={(e) => {
					e.preventDefault()
					setDragging(false)
					if (!busy) void addFiles(e.dataTransfer.files)
				}}
				className={cn(
					'flex flex-col items-center justify-center gap-1 rounded-md border border-dashed border-input p-4 text-center text-sm text-muted-foreground',
					dragging && 'border-primary bg-accent/40',
					busy && 'opacity-50',
				)}
			>
				<input
					id={id}
					ref={inputRef}
					type="file"
					accept={accept}
					multiple={multiple}
					disabled={busy}
					aria-describedby={ariaDescribedBy}
					onChange={(e) => void addFiles(e.currentTarget.files)}
					className="sr-only"
				/>
				<button
					type="button"
					disabled={busy}
					onClick={() => inputRef.current?.click()}
					className="font-medium text-foreground underline-offset-4 hover:underline"
				>
					{uploading
						? 'Uploading…'
						: `Choose ${image ? 'image' : 'file'}${multiple ? 's' : ''}`}
				</button>
				<span>or drag and drop here</span>
			</div>
			{error && (
				<p role="alert" className="text-sm text-destructive">
					{error}
				</p>
			)}
			{files.length > 0 && (
				<ul className={cn('flex gap-2', image ? 'flex-wrap' : 'flex-col')}>
					{files.map((f, i) => (
						<li
							// biome-ignore lint/suspicious/noArrayIndexKey: files carry no stable id; index is fine for a small edit list
							key={i}
							className="flex items-center gap-2 rounded border border-input p-1 pr-2 text-sm"
						>
							{image ? (
								<img
									src={f.url}
									alt={f.name}
									className="size-12 rounded object-cover"
								/>
							) : null}
							<span className="max-w-40 truncate">{f.name}</span>
							<button
								type="button"
								aria-label={`Remove ${f.name}`}
								disabled={disabled}
								onClick={() => remove(i)}
								className="ml-auto text-muted-foreground hover:text-destructive"
							>
								✕
							</button>
						</li>
					))}
				</ul>
			)}
		</div>
	)
}

/**
 * Read a stored column value back into a displayable file list.
 *
 * The value is a storage key (or a JSON array of them). `previewUrl` turns a
 * key into a signed URL for the preview; without it — a purely client-side
 * render, which cannot sign anything — the entry keeps its key and shows no
 * thumbnail rather than emitting a URL that would 403.
 *
 * Legacy values (a raw `/files/…` or `data:` URL written before keys were
 * stored) are recognized by looking like a URL and are passed through as-is, so
 * an old row still displays and re-submits unchanged.
 */
function parseFiles(
	value: string,
	previewUrl?: (key: string) => string,
): UploadedFile[] {
	if (!value) return []
	const entries: string[] = value.startsWith('[')
		? (() => {
				try {
					const parsed: unknown = JSON.parse(value)
					if (!Array.isArray(parsed)) return [value]
					// Tolerate both shapes: a plain key list (current) and the
					// {name,url,key} objects an older build wrote.
					return parsed.map((item) =>
						typeof item === 'string'
							? item
							: ((item as UploadedFile)?.key ??
								(item as UploadedFile)?.url ??
								''),
					)
				} catch {
					return [value]
				}
			})()
		: [value]

	return entries.filter(Boolean).map((entry) =>
		looksLikeUrl(entry)
			? { name: fileNameFromUrl(entry), url: entry }
			: {
					name: entry,
					key: entry,
					url: previewUrl ? previewUrl(entry) : '',
				},
	)
}

/** A stored key is a uuid plus an extension; anything with a scheme or a slash
 * is a legacy URL value. */
function looksLikeUrl(value: string): boolean {
	return value.startsWith('/') || value.includes('://')
}

function fileNameFromUrl(url: string): string {
	if (url.startsWith('data:')) return 'upload'
	return url.split('/').pop() || url
}

// --- color ------------------------------------------------------------------

/** Native color swatch + a hex text field, kept in sync. Stores the hex string. */
export function FormColorInput({
	id,
	name,
	defaultValue = '',
	ariaDescribedBy,
	className,
	disabled,
}: BaseProps) {
	const [value, setValue, register] = useControlValue(defaultValue)
	const swatch = /^#[0-9a-fA-F]{6}$/.test(value) ? value : '#000000'
	return (
		<div className={cn('flex items-center gap-2', className)}>
			<input type="hidden" name={name} ref={register} />
			<input
				type="color"
				aria-label="Color picker"
				value={swatch}
				disabled={disabled}
				onChange={(e) => setValue(e.currentTarget.value)}
				className="size-9 shrink-0 cursor-pointer rounded border border-input bg-transparent p-0.5"
			/>
			<input
				id={id}
				type="text"
				value={value}
				disabled={disabled}
				placeholder="#000000"
				aria-describedby={ariaDescribedBy}
				onChange={(e) => setValue(e.currentTarget.value)}
				className={cn(inputClass, 'font-mono')}
			/>
		</div>
	)
}

// --- JSON --------------------------------------------------------------------

/** A JSON textarea with parse validation and a Format button. Stores the raw
 * text; an invalid document shows an inline error but still submits (the server
 * schema is the final arbiter). */
export function FormJsonInput({
	id,
	name,
	defaultValue = '',
	ariaDescribedBy,
	className,
	disabled,
	placeholder,
}: BaseProps) {
	const [value, setValue, register] = useControlValue(defaultValue)
	const invalid = jsonError(value)
	const format = () => {
		try {
			setValue(JSON.stringify(JSON.parse(value), null, 2))
		} catch {
			/* leave as-is; the error is already shown */
		}
	}
	return (
		<div className={cn('space-y-1', className)}>
			<input type="hidden" name={name} ref={register} />
			<textarea
				id={id}
				value={value}
				disabled={disabled}
				placeholder={placeholder ?? '{ }'}
				aria-describedby={ariaDescribedBy}
				aria-invalid={invalid ? true : undefined}
				onChange={(e) => setValue(e.currentTarget.value)}
				className={cn(areaClass, 'font-mono', invalid && 'border-destructive')}
			/>
			<div className="flex items-center justify-between">
				<span className="text-xs text-destructive">{invalid ?? ''}</span>
				<button
					type="button"
					disabled={disabled}
					onClick={format}
					className="text-xs text-muted-foreground hover:text-foreground"
				>
					Format
				</button>
			</div>
		</div>
	)
}

/** Return a parse-error message for a non-empty, invalid JSON string, else null. */
function jsonError(value: string): string | null {
	if (!value.trim()) return null
	try {
		JSON.parse(value)
		return null
	} catch (e) {
		return e instanceof Error ? e.message : 'Invalid JSON'
	}
}

// --- slider ------------------------------------------------------------------

/** A range slider with a live value read-out. Stores the numeric value as a
 * string (Conform / Zod coerce it back). */
export function FormSlider({
	id,
	name,
	defaultValue = '',
	ariaDescribedBy,
	className,
	disabled,
	min = 0,
	max = 100,
	step = 1,
}: BaseProps & { min?: number; max?: number; step?: number }) {
	const fallback = String(min)
	const [value, setValue, register] = useControlValue(defaultValue || fallback)
	return (
		<div className={cn('flex items-center gap-3', className)}>
			<input type="hidden" name={name} ref={register} />
			<input
				id={id}
				type="range"
				min={min}
				max={max}
				step={step}
				value={value}
				disabled={disabled}
				aria-describedby={ariaDescribedBy}
				onChange={(e) => setValue(e.currentTarget.value)}
				className="h-2 flex-1 cursor-pointer accent-primary"
			/>
			<output className="w-12 text-right text-sm tabular-nums">{value}</output>
		</div>
	)
}

// --- rating ------------------------------------------------------------------

/** A 1..max star picker. Stores the chosen number as a string. */
export function FormRating({
	id,
	name,
	defaultValue = '',
	ariaDescribedBy,
	className,
	disabled,
	max = 5,
}: BaseProps & { max?: number }) {
	const [value, setValue, register] = useControlValue(defaultValue)
	const current = Number(value) || 0
	return (
		<div
			id={id}
			className={cn('inline-flex items-center gap-0.5', className)}
			aria-describedby={ariaDescribedBy}
			role="radiogroup"
			aria-label="Rating"
		>
			<input type="hidden" name={name} ref={register} />
			{Array.from({ length: max }, (_, i) => i + 1).map((n) => (
				// biome-ignore lint/a11y/useSemanticElements: a star toggle is a button acting as a radio; a native input can't carry the ★ glyph styling
				<button
					key={n}
					type="button"
					role="radio"
					aria-checked={n === current}
					aria-label={`${n} star${n > 1 ? 's' : ''}`}
					disabled={disabled}
					// A second click on the current value clears it (back to 0/unset).
					onClick={() => setValue(String(n === current ? 0 : n))}
					className={cn(
						'text-xl leading-none',
						// Gold by convention, not the theme's `warning` — see
						// `RatingField` in fields.tsx.
						n <= current ? 'text-amber-500' : 'text-muted-foreground',
					)}
				>
					{n <= current ? '★' : '☆'}
				</button>
			))}
		</div>
	)
}

// --- duration ----------------------------------------------------------------

/** Hours / minutes / seconds inputs that store a single total-seconds value. */
export function FormDurationInput({
	id,
	name,
	defaultValue = '',
	ariaDescribedBy,
	className,
	disabled,
}: BaseProps) {
	const [value, setValue, register] = useControlValue(defaultValue)
	const total = Number(value) || 0
	const h = Math.floor(total / 3600)
	const m = Math.floor((total % 3600) / 60)
	const s = total % 60
	const update = (nh: number, nm: number, ns: number) =>
		setValue(
			String(Math.max(0, nh) * 3600 + Math.max(0, nm) * 60 + Math.max(0, ns)),
		)
	const part = (
		label: string,
		val: number,
		onChange: (n: number) => void,
		first = false,
	) => (
		<label className="flex items-center gap-1 text-sm">
			<input
				id={first ? id : undefined}
				type="number"
				min={0}
				value={val}
				disabled={disabled}
				aria-label={label}
				aria-describedby={first ? ariaDescribedBy : undefined}
				onChange={(e) => onChange(Number(e.currentTarget.value) || 0)}
				className={cn(inputClass, 'w-16')}
			/>
			<span className="text-muted-foreground">{label}</span>
		</label>
	)
	return (
		<div className={cn('flex items-center gap-2', className)}>
			<input type="hidden" name={name} ref={register} />
			{part('h', h, (n) => update(n, m, s), true)}
			{part('m', m, (n) => update(h, n, s))}
			{part('s', s, (n) => update(h, m, n))}
		</div>
	)
}

// --- geo / coordinates ------------------------------------------------------

/** Latitude / longitude inputs that store a single `"lat,lng"` value. */
export function FormGeoInput({
	id,
	name,
	defaultValue = '',
	ariaDescribedBy,
	className,
	disabled,
}: BaseProps) {
	const [value, setValue, register] = useControlValue(defaultValue)
	const [lat, lng] = splitLatLng(value)
	const commit = (nlat: string, nlng: string) =>
		setValue(nlat === '' && nlng === '' ? '' : `${nlat},${nlng}`)
	const latId = useId()
	return (
		<div className={cn('flex items-center gap-2', className)}>
			<input type="hidden" name={name} ref={register} />
			<input
				id={id ?? latId}
				type="number"
				step="any"
				value={lat}
				disabled={disabled}
				placeholder="lat"
				aria-label="Latitude"
				aria-describedby={ariaDescribedBy}
				onChange={(e) => commit(e.currentTarget.value, lng)}
				className={cn(inputClass, 'w-28')}
			/>
			<input
				type="number"
				step="any"
				value={lng}
				disabled={disabled}
				placeholder="lng"
				aria-label="Longitude"
				onChange={(e) => commit(lat, e.currentTarget.value)}
				className={cn(inputClass, 'w-28')}
			/>
		</div>
	)
}

function splitLatLng(value: string): [string, string] {
	const parts = value.split(',')
	return [parts[0] ?? '', parts[1] ?? '']
}
