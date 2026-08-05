/** The recursive field renderer for `<DynamicForm>` — structural widgets
 * (objects, arrays, unions) plus every leaf widget, upgraded from column
 * metadata and per-field `uiOptions`. */

import { getInputProps, getTextareaProps } from '@conform-to/react'
import { useState } from 'react'
import {
	detectInputWidget,
	type SpecialtyWidget,
} from '../fields/field-semantics.ts'
import { parseReferenceIds } from '../fields/fields.tsx'
import { cn } from '../lib/cn.ts'
import {
	FormAutocomplete,
	FormCheckbox,
	FormMultiCheckboxGroup,
	FormRadioGroup,
	FormReferenceArrayInput,
	FormSelect,
} from '../ui/form-fields.tsx'
import { Button, Input, Label, Textarea } from '../ui/primitives.tsx'
import {
	FormColorInput,
	FormDurationInput,
	FormFileInput,
	FormGeoInput,
	FormJsonInput,
	FormMarkdownEditor,
	FormRating,
	FormRichTextEditor,
	FormSlider,
} from '../ui/rich-inputs.tsx'
import type { FormFieldConfig } from '../zod-to-form-fields.ts'
import { DateInput } from './DateInput.tsx'
import {
	type AnyField,
	fieldContainerClass,
	getFieldListOf,
	getFieldsetOf,
	keyOf,
	labeledOptions,
	leafKey,
	type RenderCtx,
	toDateInputValue,
} from './field-tree.ts'
import type { InputTypeOverride } from './types.ts'

interface FieldRendererProps {
	config: FormFieldConfig
	meta: AnyField
	ctx: RenderCtx
}

export function FieldRenderer({ config, meta, ctx }: FieldRendererProps) {
	if (ctx.hidden.has(config.path)) return null

	const uiOptions = ctx.uiOptions[config.path]
	const form = ctx.form
	const label = uiOptions?.label ?? config.label
	const fieldLayout = uiOptions?.layout ?? 'vertical'
	const disabled = ctx.disabled.has(config.path)
	const errors = meta.errors ?? ctx.serverErrorFor(config.path)

	// --- structural widgets --------------------------------------------------

	if (config.type === 'object') {
		const sub = getFieldsetOf(meta)
		return (
			<fieldset className="space-y-3 rounded-md border border-input p-3">
				<legend className="px-1 text-sm font-medium">{label}</legend>
				{(config.fields ?? []).map((child) => (
					<FieldRenderer
						key={child.path}
						config={child}
						meta={sub[leafKey(child.path)] as AnyField}
						ctx={ctx}
					/>
				))}
			</fieldset>
		)
	}

	// An array-reference column (`meta.arrayReference`, task 38) is an array in the
	// schema but edits as a single multi-value picker, not the generic repeatable
	// array container — fall through to the leaf widgets, which resolve it to the
	// `reference-array` input.
	const isArrayReferenceField =
		ctx.columns.get(config.path)?.meta?.arrayReference != null

	if (config.type === 'array' && config.element && !isArrayReferenceField) {
		const items = getFieldListOf(meta)
		const element = config.element
		const lastIndex = items.length - 1
		return (
			<fieldset className="space-y-3 rounded-md border border-input p-3">
				<legend className="px-1 text-sm font-medium">{label}</legend>
				{items.map((item: AnyField, index: number) => (
					<div key={keyOf(item) ?? index} className="flex items-start gap-2">
						<div className="flex-1">
							<FieldRenderer
								config={{ ...element, label: `${label} ${index + 1}` }}
								meta={item}
								ctx={ctx}
							/>
						</div>
						<div className="flex flex-col gap-1">
							<Button
								type="button"
								aria-label={`Move ${label} ${index + 1} up`}
								disabled={index === 0}
								onClick={() =>
									form.reorder({ name: meta.name, from: index, to: index - 1 })
								}
								className="h-7 px-2"
							>
								↑
							</Button>
							<Button
								type="button"
								aria-label={`Move ${label} ${index + 1} down`}
								disabled={index === lastIndex}
								onClick={() =>
									form.reorder({ name: meta.name, from: index, to: index + 1 })
								}
								className="h-7 px-2"
							>
								↓
							</Button>
							<Button
								type="button"
								aria-label={`Remove ${label} ${index + 1}`}
								className="h-7 bg-destructive px-2 text-white hover:bg-destructive/90"
								onClick={() => form.remove({ name: meta.name, index })}
							>
								✕
							</Button>
						</div>
					</div>
				))}
				<Button type="button" onClick={() => form.insert({ name: meta.name })}>
					Add {label}
				</Button>
			</fieldset>
		)
	}

	if (config.type === 'union' && config.branches) {
		return <UnionField config={config} meta={meta} ctx={ctx} label={label} />
	}

	// --- leaf widgets --------------------------------------------------------

	// A column's metadata can upgrade the schema-inferred widget into a rich
	// editor (markdown / upload / color / …) — the write dual of `<Field>`
	// reading `column` on the display side. Explicit `uiOptions.inputType` wins;
	// then metadata; then the schema-derived `config.type`.
	const column = ctx.columns.get(config.path)
	const metaWidget: SpecialtyWidget | null = column
		? detectInputWidget(column)
		: null
	// An array-reference column (`meta.arrayReference`) edits as the multi-value
	// FK picker (task 38) unless the caller forced another widget; a single FK
	// (`column.references`) auto-selects the reference picker the same way, so a
	// route only has to supply `referenceOptions` — never `inputType`.
	const referenceArray = column?.meta?.arrayReference != null
	const inputType: InputTypeOverride =
		uiOptions?.inputType ??
		(referenceArray ? 'reference-array' : null) ??
		(column?.references != null ? 'reference' : null) ??
		metaWidget ??
		config.type
	const placeholder =
		uiOptions?.placeholder ??
		(inputType === 'select' || inputType === 'multi-select'
			? `Select ${label.toLowerCase()}`
			: `Enter ${label.toLowerCase()}`)

	const labelNode = (
		<span className="flex items-center gap-0.5">
			<Label
				htmlFor={meta.id}
				className={cn(fieldLayout === 'horizontal' && 'min-w-24 shrink-0')}
			>
				{label}
			</Label>
			{config.required && (
				<span aria-hidden className="text-destructive">
					*
				</span>
			)}
		</span>
	)

	// Non-native widgets own their value via `useControl`, so seed them from the
	// form's initial value (row data on edit) and only fall back to the schema
	// default — otherwise editing a record shows the default, not the record.
	const initial = meta.initialValue as string | string[] | undefined
	const initialScalar =
		initial !== undefined
			? String(Array.isArray(initial) ? (initial[0] ?? '') : initial)
			: undefined

	const cmeta = column?.meta
	const richDefault = initialScalar ?? String(config.defaultValue ?? '')

	let control: React.ReactNode
	if (inputType === 'reference') {
		control = (
			<FormAutocomplete
				id={meta.id}
				name={meta.name}
				options={uiOptions?.referenceOptions ?? []}
				defaultValue={initialScalar ?? String(config.defaultValue ?? '')}
				placeholder={placeholder}
				ariaDescribedBy={meta.errorId}
				className={uiOptions?.className}
				onCreate={uiOptions?.onCreateReference}
			/>
		)
	} else if (inputType === 'reference-array') {
		// The initial value is the record's array of FK ids (jsonb), or a JSON
		// string that crossed a wire — `parseReferenceIds` coerces either to a
		// `string[]` and never throws on junk.
		control = (
			<FormReferenceArrayInput
				id={meta.id}
				name={meta.name}
				options={uiOptions?.referenceOptions ?? []}
				defaultValue={parseReferenceIds(initial ?? config.defaultValue)}
				placeholder={placeholder}
				ariaDescribedBy={meta.errorId}
				className={uiOptions?.className}
				onCreate={uiOptions?.onCreateReference}
			/>
		)
	} else if (inputType === 'markdown') {
		control = (
			<FormMarkdownEditor
				id={meta.id}
				name={meta.name}
				defaultValue={richDefault}
				ariaDescribedBy={meta.errorId}
				className={uiOptions?.className}
				disabled={disabled}
				placeholder={uiOptions?.placeholder}
			/>
		)
	} else if (inputType === 'richtext') {
		control = (
			<FormRichTextEditor
				id={meta.id}
				name={meta.name}
				defaultValue={richDefault}
				ariaDescribedBy={meta.errorId}
				className={uiOptions?.className}
				disabled={disabled}
			/>
		)
	} else if (inputType === 'file' || inputType === 'image') {
		control = (
			<FormFileInput
				id={meta.id}
				name={meta.name}
				defaultValue={richDefault}
				ariaDescribedBy={meta.errorId}
				className={uiOptions?.className}
				disabled={disabled}
				image={inputType === 'image'}
				accept={cmeta?.fileAccept}
				maxSize={cmeta?.fileMaxSize}
				// Names the declared field so the upload endpoint can enforce that
				// field's own allowlist and cap.
				resource={cmeta?.fileResource}
				previewUrl={ctx.filePreviewUrl}
			/>
		)
	} else if (inputType === 'color') {
		control = (
			<FormColorInput
				id={meta.id}
				name={meta.name}
				defaultValue={richDefault}
				ariaDescribedBy={meta.errorId}
				className={uiOptions?.className}
				disabled={disabled}
			/>
		)
	} else if (inputType === 'json') {
		// The row's value on edit (and a schema default) is a real container —
		// serialize it. `richDefault` would render an object as `[object Object]`
		// and an array as just its first element. Prefer the raw row over
		// Conform's `initialValue`, whose leaves are stringified (10 → "10").
		const raw = ctx.initialValues?.[config.path]
		const jsonSource =
			typeof raw === 'object' && raw !== null
				? raw
				: typeof initial === 'object' && initial !== null
					? initial
					: typeof config.defaultValue === 'object' &&
							config.defaultValue !== null
						? config.defaultValue
						: undefined
		control = (
			<FormJsonInput
				id={meta.id}
				name={meta.name}
				defaultValue={
					jsonSource !== undefined
						? JSON.stringify(jsonSource, null, 2)
						: richDefault
				}
				ariaDescribedBy={meta.errorId}
				className={uiOptions?.className}
				disabled={disabled}
				placeholder={uiOptions?.placeholder}
			/>
		)
	} else if (inputType === 'slider') {
		control = (
			<FormSlider
				id={meta.id}
				name={meta.name}
				defaultValue={richDefault}
				ariaDescribedBy={meta.errorId}
				className={uiOptions?.className}
				disabled={disabled}
				min={cmeta?.min}
				max={cmeta?.max}
				step={cmeta?.step}
			/>
		)
	} else if (inputType === 'rating') {
		control = (
			<FormRating
				id={meta.id}
				name={meta.name}
				defaultValue={richDefault}
				ariaDescribedBy={meta.errorId}
				className={uiOptions?.className}
				disabled={disabled}
				max={typeof cmeta?.max === 'number' ? cmeta.max : undefined}
			/>
		)
	} else if (inputType === 'duration') {
		control = (
			<FormDurationInput
				id={meta.id}
				name={meta.name}
				defaultValue={richDefault}
				ariaDescribedBy={meta.errorId}
				className={uiOptions?.className}
				disabled={disabled}
			/>
		)
	} else if (inputType === 'geo') {
		control = (
			<FormGeoInput
				id={meta.id}
				name={meta.name}
				defaultValue={richDefault}
				ariaDescribedBy={meta.errorId}
				className={uiOptions?.className}
				disabled={disabled}
			/>
		)
	} else if (inputType === 'checkbox') {
		control = (
			<div className="flex items-center gap-2">
				<FormCheckbox
					id={meta.id}
					name={meta.name}
					defaultChecked={
						initial !== undefined
							? initial === 'on' || initial === 'true'
							: Boolean(config.defaultValue)
					}
					ariaDescribedBy={meta.errorId}
					className={uiOptions?.className}
				/>
				<Label htmlFor={meta.id}>{label}</Label>
			</div>
		)
	} else if (inputType === 'select') {
		control = (
			<FormSelect
				id={meta.id}
				name={meta.name}
				options={labeledOptions(config, column)}
				defaultValue={initialScalar ?? String(config.defaultValue ?? '')}
				placeholder={placeholder}
				ariaDescribedBy={meta.errorId}
				className={uiOptions?.className}
			/>
		)
	} else if (inputType === 'multi-select') {
		control = (
			<FormMultiCheckboxGroup
				name={meta.name}
				options={labeledOptions(config, column)}
				defaultValue={
					initial !== undefined
						? Array.isArray(initial)
							? initial
							: [initial]
						: Array.isArray(config.defaultValue)
							? config.defaultValue
							: []
				}
				ariaDescribedBy={meta.errorId}
				className={uiOptions?.className}
			/>
		)
	} else if (inputType === 'radiogroup') {
		control = (
			<FormRadioGroup
				id={meta.id}
				name={meta.name}
				options={labeledOptions(config, column)}
				defaultValue={initialScalar ?? String(config.defaultValue ?? '')}
				ariaDescribedBy={meta.errorId}
				className={uiOptions?.className}
			/>
		)
	} else if (inputType === 'textarea') {
		control = (
			<Textarea
				{...getTextareaProps(meta)}
				disabled={disabled}
				placeholder={placeholder}
				className={uiOptions?.className}
			/>
		)
	} else if (inputType === 'date') {
		// A native `type="date"` cannot be typed into: Chrome's year
		// segment takes six digits and swallows `-`, so the `yyyy-mm-dd` hint it
		// displays is exactly the string that fails. `<DateInput>` is a text field
		// plus the same native picker — and, unlike a segmented control, something
		// a test can drive.
		const dateProps = getInputProps(meta, { type: 'text' })
		control = (
			<DateInput
				id={meta.id}
				name={meta.name}
				defaultValue={toDateInputValue(dateProps.defaultValue)}
				disabled={disabled}
				required={dateProps.required}
				className={uiOptions?.className}
				aria-describedby={meta.errorId}
			/>
		)
	} else {
		const htmlType =
			inputType === 'number'
				? 'number'
				: inputType === 'email'
					? 'email'
					: inputType === 'url'
						? 'url'
						: inputType === 'password'
							? 'password'
							: 'text'
		const inputProps = getInputProps(meta, { type: htmlType })
		control = (
			<Input
				{...inputProps}
				disabled={disabled}
				placeholder={placeholder}
				className={uiOptions?.className}
			/>
		)
	}

	return (
		<div className={fieldContainerClass(fieldLayout)}>
			{inputType !== 'checkbox' && labelNode}
			{control}
			{uiOptions?.helpText && (
				<p className="text-sm text-muted-foreground">{uiOptions.helpText}</p>
			)}
			{errors && (
				<p id={meta.errorId} className="text-sm text-destructive">
					{errors[0]}
				</p>
			)}
		</div>
	)
}

interface UnionFieldProps {
	config: FormFieldConfig
	meta: AnyField
	ctx: RenderCtx
	label: string
}

function UnionField({ config, meta, ctx, label }: UnionFieldProps) {
	const branches = config.branches ?? []
	const [branchIndex, setBranchIndex] = useState(0)
	const sub = getFieldsetOf(meta)
	const active = branches[branchIndex]

	return (
		<fieldset className="space-y-3 rounded-md border border-input p-3">
			<legend className="px-1 text-sm font-medium">{label}</legend>
			<div className="space-y-2">
				<Label htmlFor={`${meta.id}-branch`}>Type</Label>
				{/* Branch selector — local UI state only; the chosen branch's fields
				    submit under the union's name and parseWithZod picks the match. */}
				<select
					id={`${meta.id}-branch`}
					value={branchIndex}
					onChange={(e) => setBranchIndex(Number(e.currentTarget.value))}
					className="h-9 w-full rounded-md border border-input bg-transparent px-3 text-sm"
				>
					{branches.map((branch, i) => (
						// biome-ignore lint/suspicious/noArrayIndexKey: branch order is stable
						<option key={i} value={i}>
							{branch.label}
						</option>
					))}
				</select>
			</div>
			{active?.fields.map((child) => (
				<FieldRenderer
					key={child.path}
					config={child}
					meta={sub[leafKey(child.path)] as AnyField}
					ctx={ctx}
				/>
			))}
		</fieldset>
	)
}
