/**
 * Conform-bound Base UI widgets. These are the non-native controls the
 * reference spec (the reference design"Coupling to update")
 * says to reimplement on Base UI, re-verifying the Conform `useControl` +
 * hidden-input bridge fires change/blur with Base UI's controlled components.
 *
 * Bridge pattern: `useControl` owns the form value; the Base UI Root is
 * controlled by it (`checked`/`value`) and its own hidden `<input>` is
 * registered with Conform via `inputRef={control.register}` — so there is
 * exactly one submitted input per field and user interaction flows
 * widget → onChange → control.change → Conform → re-render.
 */

import { Checkbox } from '@base-ui/react/checkbox'
import { Radio } from '@base-ui/react/radio'
import { RadioGroup } from '@base-ui/react/radio-group'
import { Select } from '@base-ui/react/select'
import { useControl } from '@conform-to/react/future'
import { useId, useMemo, useRef, useState } from 'react'
import {
	REFERENCE_OPTION_PAGE,
	type ReferenceSearchPlan,
	useReferenceSearch,
	useResolvedReferenceLabel,
} from '../form/reference-search.ts'
import { cn } from '../lib/cn.ts'

interface FieldWidgetProps {
	id?: string
	name: string
	ariaDescribedBy?: string
	className?: string
}

/** An option-list entry: a bare string, or a labeled value (what the user reads
 * vs. what submits) — so an enum with `meta.options` shows its labels. */
export type SelectOption = string | { label: string; value: string }

const optionValue = (o: SelectOption): string =>
	typeof o === 'string' ? o : o.value
const optionLabel = (o: SelectOption): string =>
	typeof o === 'string' ? o : o.label

export function FormCheckbox({
	id,
	name,
	defaultChecked = false,
	ariaDescribedBy,
	className,
}: FieldWidgetProps & { defaultChecked?: boolean }) {
	const control = useControl({ defaultChecked })
	return (
		<Checkbox.Root
			id={id}
			name={name}
			checked={control.checked ?? false}
			onCheckedChange={(checked) => control.change(checked)}
			inputRef={control.register}
			aria-describedby={ariaDescribedBy}
			className={cn(
				'flex size-4 items-center justify-center rounded border border-input shadow-sm data-[checked]:bg-primary data-[checked]:text-primary-foreground',
				className,
			)}
		>
			<Checkbox.Indicator className="text-xs leading-none">
				✓
			</Checkbox.Indicator>
		</Checkbox.Root>
	)
}

export function FormSelect({
	id,
	name,
	options,
	defaultValue = '',
	placeholder,
	ariaDescribedBy,
	className,
}: FieldWidgetProps & {
	options: SelectOption[]
	defaultValue?: string
	placeholder?: string
}) {
	const control = useControl({ defaultValue })
	const labelFor = (value: string): string => {
		const match = options.find((o) => optionValue(o) === value)
		return match ? optionLabel(match) : value
	}
	return (
		<Select.Root
			name={name}
			value={control.value ?? ''}
			onValueChange={(value) => control.change(String(value ?? ''))}
			inputRef={control.register}
		>
			<Select.Trigger
				id={id}
				aria-describedby={ariaDescribedBy}
				className={cn(
					'flex h-9 w-full items-center justify-between rounded-md border border-input bg-transparent px-3 py-2 text-sm shadow-sm focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring',
					className,
				)}
			>
				<Select.Value>
					{(value: unknown) =>
						value === null || value === undefined || value === ''
							? placeholder
							: labelFor(String(value))
					}
				</Select.Value>
				<Select.Icon className="ml-2 opacity-50">▾</Select.Icon>
			</Select.Trigger>
			<Select.Portal>
				<Select.Positioner className="z-50">
					<Select.Popup className="max-h-60 overflow-auto rounded-md border border-input bg-popover p-1 text-sm shadow-md">
						{options.map((option) => (
							<Select.Item
								key={optionValue(option)}
								value={optionValue(option)}
								className="flex cursor-default items-center gap-2 rounded px-2 py-1.5 data-[highlighted]:bg-accent"
							>
								<Select.ItemText>{optionLabel(option)}</Select.ItemText>
							</Select.Item>
						))}
					</Select.Popup>
				</Select.Positioner>
			</Select.Portal>
		</Select.Root>
	)
}

export function FormRadioGroup({
	id,
	name,
	options,
	defaultValue = '',
	ariaDescribedBy,
	className,
}: FieldWidgetProps & { options: SelectOption[]; defaultValue?: string }) {
	const control = useControl({ defaultValue })
	return (
		<RadioGroup
			id={id}
			name={name}
			value={control.value ?? ''}
			onValueChange={(value) => control.change(String(value ?? ''))}
			inputRef={control.register}
			aria-describedby={ariaDescribedBy}
			className={cn('flex flex-col gap-2', className)}
		>
			{options.map((option) => (
				// biome-ignore lint/a11y/noLabelWithoutControl: Radio.Root renders the control
				<label
					key={optionValue(option)}
					className="flex items-center gap-2 text-sm"
				>
					<Radio.Root
						value={optionValue(option)}
						className="flex size-4 items-center justify-center rounded-full border border-input shadow-sm"
					>
						<Radio.Indicator className="size-2 rounded-full bg-primary" />
					</Radio.Root>
					{optionLabel(option)}
				</label>
			))}
		</RadioGroup>
	)
}

/** A picker option: what the user reads (`label`) vs. what submits (`value`). */
export interface AutocompleteOption {
	label: string
	value: string
}

/**
 * A searchable single-select combobox that submits an id while showing a label
 * — the FK picker `<ReferenceInput>` is built on (Plan v5 task 32). Bridged to
 * Conform exactly like `FormSelect`: `useControl` owns the submitted value and a
 * hidden `<input name>` is registered, so exactly one id submits per field.
 *
 * With `onCreate` an unmatched query offers a "Create" row that mints a new
 * option inline (react-admin's create-inline) and selects it.
 *
 * With `search` — and a `<DataProvider>` in context — a query goes to the
 * referenced resource instead of filtering `options`, which is only ever the
 * loader's first page (#442). Without either, the old client-side filter stands.
 */
export function FormAutocomplete({
	id,
	name,
	options,
	defaultValue = '',
	placeholder,
	ariaDescribedBy,
	className,
	onCreate,
	search,
}: FieldWidgetProps & {
	options: AutocompleteOption[]
	defaultValue?: string
	placeholder?: string
	onCreate?: (label: string) => Promise<AutocompleteOption> | AutocompleteOption
	search?: ReferenceSearchPlan
}) {
	const control = useControl({ defaultValue })
	const [extra, setExtra] = useState<AutocompleteOption[]>([])
	const all = useMemo(() => [...options, ...extra], [options, extra])
	const selected = control.value ?? ''

	const [open, setOpen] = useState(false)
	const [query, setQuery] = useState('')
	const listId = useId()
	const blurTimer = useRef<ReturnType<typeof setTimeout> | null>(null)

	const {
		options: candidates,
		fromServer,
		searching,
		failed,
		pageIsFull,
		canSearch,
	} = useReferenceSearch({ plan: search, options, query, extra })
	// A stored id the loaded page does not carry has a label on the server and
	// nowhere here; resolving it is what keeps a set reference from rendering as
	// an empty box (#442).
	const resolved = useResolvedReferenceLabel({
		plan: search,
		value: selected,
		known: all.some((o) => o.value === selected),
	})
	const labelFor = (value: string) =>
		all.find((o) => o.value === value)?.label ??
		(resolved?.value === value ? resolved.label : '')

	// The server has already matched, so its answer is rendered as it came:
	// re-filtering would narrow by a rule the server does not share (it matched
	// the declared search field; this matches the rendered label) and drop rows
	// it said match. The client filter applies to the local page only.
	const filtered =
		query && !fromServer
			? candidates.filter((o) =>
					o.label.toLowerCase().includes(query.toLowerCase()),
				)
			: candidates
	const exactMatch = candidates.some(
		(o) => o.label.toLowerCase() === query.trim().toLowerCase(),
	)

	function choose(option: AutocompleteOption) {
		control.change(option.value)
		setQuery('')
		setOpen(false)
	}

	async function create() {
		if (!onCreate) return
		const created = await onCreate(query.trim())
		setExtra((prev) => [...prev, created])
		choose(created)
	}

	// While open the input shows the live query; when closed it shows the
	// selected option's label (or the placeholder via the input's own value).
	const inputValue = open ? query : selected ? labelFor(selected) : ''

	return (
		<div className={cn('relative', className)}>
			{/* The single submitted input — the referenced record's id. */}
			<input type="hidden" name={name} ref={control.register} />
			<input
				id={id}
				role="combobox"
				aria-expanded={open}
				aria-controls={listId}
				aria-describedby={ariaDescribedBy}
				autoComplete="off"
				value={inputValue}
				placeholder={placeholder}
				onFocus={() => setOpen(true)}
				onChange={(e) => {
					setQuery(e.currentTarget.value)
					setOpen(true)
				}}
				onBlur={() => {
					// Delay so an option's mousedown/click lands before we close.
					blurTimer.current = setTimeout(() => setOpen(false), 120)
				}}
				className="flex h-9 w-full items-center rounded-md border border-input bg-transparent px-3 py-2 text-sm shadow-sm focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
			/>
			{open && (
				<div
					id={listId}
					role="listbox"
					className="absolute z-50 mt-1 max-h-60 w-full overflow-auto rounded-md border border-input bg-popover p-1 text-sm shadow-md"
				>
					{filtered.map((option) => (
						<button
							key={option.value}
							type="button"
							role="option"
							aria-selected={option.value === selected}
							onMouseDown={(e) => e.preventDefault()}
							onClick={() => {
								if (blurTimer.current) clearTimeout(blurTimer.current)
								choose(option)
							}}
							className="flex w-full cursor-default items-center rounded px-2 py-1.5 text-left hover:bg-accent aria-selected:font-medium"
						>
							{option.label}
						</button>
					))}
					{searching && (
						<p className="px-2 py-1.5 text-muted-foreground">Searching…</p>
					)}
					{/* A failed request is not an absence of records, and saying "No
					    matches" for one tells the user their record does not exist. */}
					{failed && (
						<p className="px-2 py-1.5 text-destructive">
							Could not search {search?.resource ?? 'records'} — try again
						</p>
					)}
					{filtered.length === 0 && !onCreate && !searching && !failed && (
						<p className="px-2 py-1.5 text-muted-foreground">No matches</p>
					)}
					{/* The loader sends one page. With a full page there is no way to
					    know from here whether one more record exists or a million, so
					    the list says what it is instead of implying it is everything. */}
					{pageIsFull && !searching && (
						<p className="px-2 py-1.5 text-muted-foreground text-xs">
							{canSearch
								? `Showing the first ${REFERENCE_OPTION_PAGE} — type to search them all`
								: `Showing the first ${REFERENCE_OPTION_PAGE}`}
						</p>
					)}
					{onCreate && query.trim() && !exactMatch && (
						<button
							type="button"
							onMouseDown={(e) => e.preventDefault()}
							onClick={() => {
								if (blurTimer.current) clearTimeout(blurTimer.current)
								void create()
							}}
							className="flex w-full items-center rounded px-2 py-1.5 text-left text-primary hover:bg-accent"
						>
							Create “{query.trim()}”
						</button>
					)}
				</div>
			)}
		</div>
	)
}

/**
 * Multi-select as a Base UI checkbox group. Each option is a native-submitting
 * checkbox sharing the field `name`; the checked options submit as repeated
 * entries → a `string[]` that `parseWithZod` reads for `z.array(z.enum(...))`.
 */
export function FormMultiCheckboxGroup({
	name,
	options,
	defaultValue = [],
	ariaDescribedBy,
	className,
}: FieldWidgetProps & { options: SelectOption[]; defaultValue?: string[] }) {
	const selected = new Set(defaultValue)
	return (
		<fieldset
			aria-describedby={ariaDescribedBy}
			className={cn('flex flex-col gap-2', className)}
		>
			{options.map((option) => (
				// biome-ignore lint/a11y/noLabelWithoutControl: Checkbox.Root renders the control
				<label
					key={optionValue(option)}
					className="flex items-center gap-2 text-sm"
				>
					<Checkbox.Root
						name={name}
						value={optionValue(option)}
						defaultChecked={selected.has(optionValue(option))}
						className="flex size-4 items-center justify-center rounded border border-input shadow-sm data-[checked]:bg-primary data-[checked]:text-primary-foreground"
					>
						<Checkbox.Indicator className="text-xs leading-none">
							✓
						</Checkbox.Indicator>
					</Checkbox.Root>
					{optionLabel(option)}
				</label>
			))}
		</fieldset>
	)
}

/**
 * The multi-value FK picker — `<ReferenceArrayInput>`'s control (Plan v5 task
 * 38). Selected references show as removable chips; a searchable combobox adds
 * more from the referenced records. Each selected id submits as its own hidden
 * `<input>` sharing the field `name` — repeated entries `parseWithZod` reads as
 * a `string[]` for `z.array(z.string())`, exactly like `FormMultiCheckboxGroup`.
 * No Conform `useControl` needed: the submitted shape is native.
 *
 * With `onCreate` an unmatched query offers a create-inline row (react-admin's
 * pattern), minting a new option and selecting it.
 *
 * `search` gives it the same server-side query as the single picker (#442). A
 * chip whose label is not in the loaded page falls back to the id — ugly and
 * true, where the single picker's blank box was tidy and false.
 */
export function FormReferenceArrayInput({
	id,
	name,
	options,
	defaultValue = [],
	placeholder,
	ariaDescribedBy,
	className,
	onCreate,
	search,
}: FieldWidgetProps & {
	options: AutocompleteOption[]
	defaultValue?: string[]
	placeholder?: string
	onCreate?: (label: string) => Promise<AutocompleteOption> | AutocompleteOption
	search?: ReferenceSearchPlan
}) {
	const [selected, setSelected] = useState<string[]>(defaultValue)
	const [extra, setExtra] = useState<AutocompleteOption[]>([])
	const all = useMemo(() => [...options, ...extra], [options, extra])
	const labelFor = (value: string) =>
		all.find((o) => o.value === value)?.label ?? value

	const [open, setOpen] = useState(false)
	const [query, setQuery] = useState('')
	const listId = useId()
	const blurTimer = useRef<ReturnType<typeof setTimeout> | null>(null)

	const {
		options: candidates,
		fromServer,
		searching,
		failed,
		pageIsFull,
		canSearch,
	} = useReferenceSearch({ plan: search, options, query, extra })
	const available = candidates.filter(
		(o) =>
			!selected.includes(o.value) &&
			// Already matched by the server; see the note in `FormAutocomplete`.
			(query && !fromServer
				? o.label.toLowerCase().includes(query.toLowerCase())
				: true),
	)
	const exactMatch = candidates.some(
		(o) => o.label.toLowerCase() === query.trim().toLowerCase(),
	)

	function add(value: string) {
		setSelected((prev) => (prev.includes(value) ? prev : [...prev, value]))
		setQuery('')
		setOpen(false)
	}
	function remove(value: string) {
		setSelected((prev) => prev.filter((v) => v !== value))
	}
	async function create() {
		if (!onCreate) return
		const created = await onCreate(query.trim())
		setExtra((prev) => [...prev, created])
		add(created.value)
	}

	return (
		<div className={cn('space-y-1.5', className)}>
			{/* One hidden input per selected id → a repeated field → a string[]. */}
			{selected.map((value) => (
				<input key={value} type="hidden" name={name} value={value} readOnly />
			))}
			{selected.length > 0 && (
				<div className="flex flex-wrap gap-1">
					{selected.map((value) => (
						<span
							key={value}
							className="inline-flex items-center gap-1 rounded-full border border-input bg-secondary px-2 py-0.5 text-xs text-secondary-foreground"
						>
							{labelFor(value)}
							<button
								type="button"
								aria-label={`Remove ${labelFor(value)}`}
								onClick={() => remove(value)}
								className="text-muted-foreground hover:text-foreground"
							>
								×
							</button>
						</span>
					))}
				</div>
			)}
			<div className="relative">
				<input
					id={id}
					role="combobox"
					aria-expanded={open}
					aria-controls={listId}
					aria-describedby={ariaDescribedBy}
					autoComplete="off"
					value={query}
					placeholder={placeholder}
					onFocus={() => setOpen(true)}
					onChange={(e) => {
						setQuery(e.currentTarget.value)
						setOpen(true)
					}}
					onBlur={() => {
						blurTimer.current = setTimeout(() => setOpen(false), 120)
					}}
					className="flex h-9 w-full items-center rounded-md border border-input bg-transparent px-3 py-2 text-sm shadow-sm focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
				/>
				{open && (
					<div
						id={listId}
						role="listbox"
						className="absolute z-50 mt-1 max-h-60 w-full overflow-auto rounded-md border border-input bg-popover p-1 text-sm shadow-md"
					>
						{available.map((option) => (
							<button
								key={option.value}
								type="button"
								role="option"
								aria-selected={false}
								onMouseDown={(e) => e.preventDefault()}
								onClick={() => {
									if (blurTimer.current) clearTimeout(blurTimer.current)
									add(option.value)
								}}
								className="flex w-full cursor-default items-center rounded px-2 py-1.5 text-left hover:bg-accent"
							>
								{option.label}
							</button>
						))}
						{searching && (
							<p className="px-2 py-1.5 text-muted-foreground">Searching…</p>
						)}
						{failed && (
							<p className="px-2 py-1.5 text-destructive">
								Could not search {search?.resource ?? 'records'} — try again
							</p>
						)}
						{available.length === 0 && !onCreate && !searching && !failed && (
							<p className="px-2 py-1.5 text-muted-foreground">No matches</p>
						)}
						{pageIsFull && !searching && (
							<p className="px-2 py-1.5 text-muted-foreground text-xs">
								{canSearch
									? `Showing the first ${REFERENCE_OPTION_PAGE} — type to search them all`
									: `Showing the first ${REFERENCE_OPTION_PAGE}`}
							</p>
						)}
						{onCreate && query.trim() && !exactMatch && (
							<button
								type="button"
								onMouseDown={(e) => e.preventDefault()}
								onClick={() => {
									if (blurTimer.current) clearTimeout(blurTimer.current)
									void create()
								}}
								className="flex w-full items-center rounded px-2 py-1.5 text-left text-primary hover:bg-accent"
							>
								Create “{query.trim()}”
							</button>
						)}
					</div>
				)}
			</div>
		</div>
	)
}
