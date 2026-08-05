/**
 * `<DynamicForm>` — reimplementation of the specbase original
 * (docs/reference-specs/dynamic-form.md). Pass a `z.ZodObject`; get a rendered,
 * Conform-wired, server-validating form.
 *
 * What changed vs. the original (all its documented-but-unimplemented gaps):
 *   - Optional / nullable fields render (were silently dropped).
 *   - Nested objects render through Conform's `getFieldset()` (the original
 *     looked them up as flat `fields['address.street']`, which never matched).
 *   - General arrays render as repeaters via `getFieldList()` + insert/remove/
 *     reorder intents; `array(enum)` still collapses to a multi-select.
 *   - Unions render a branch selector.
 *   - email / url / date / file widgets are auto-detected by the introspector.
 *   - `getZodConstraint` wires progressive-enhancement required/min/max — the
 *     original derived none of this (validation was runtime-only).
 *
 * Form-layer parity (Plan v5 task 37) — all derived from the *same* introspected
 * schema, all owned-code props (never spec keys):
 *   - **Sections** — group top-level fields into panels / tabs / accordion.
 *   - **Wizard** — render sections as ordered steps with per-step validation and
 *     a progress affordance.
 *   - **Conditional fields** — show / hide / require a field from another field's
 *     value via `conditions` predicates (see form/conditions.ts).
 *   - **Server errors** — a `serverErrors` map (422 `fieldErrors`) surfaces on the
 *     matching field and clears when the user edits it.
 *   - **Conveniences** — `transform` before save, save-and-add-another,
 *     `dirtyGuard` (warn on unsaved unload), and an autosave `draft`.
 *
 * Non-native widgets (select, checkbox, radio) are Base UI controls bridged to
 * Conform with `useControl` (see ui/form-fields.tsx).
 */

import { getFormProps, useForm } from '@conform-to/react'
import { getZodConstraint, parseWithZod } from '@conform-to/zod/v4'
import { useEffect, useMemo, useRef, useState } from 'react'
import type { z } from 'zod'
import type { IntrospectedColumn } from './fields/field-semantics.ts'
import { SectionedBody, WizardBody } from './form/bodies.tsx'
import {
	type FieldCondition,
	type FormValues,
	refineConditions,
	resolveConditions,
} from './form/conditions.ts'
import { FieldRenderer } from './form/FieldRenderer.tsx'
import {
	type AnyField,
	collectTopLevelDefaults,
	fieldOwnsError,
	type RenderCtx,
	type ResolvedSection,
	resolveSections,
	walkFieldConfigs,
} from './form/field-tree.ts'
import type {
	FieldUiOptions,
	FormLayout,
	FormSection,
	SectionVariant,
} from './form/types.ts'
import { useDirtyGuard } from './form/use-dirty-guard.ts'
import { type DraftStorage, useFormDraft } from './form/use-form-draft.ts'
import { cn } from './lib/cn.ts'
import { Button } from './ui/primitives.tsx'
import { zodToFormFields } from './zod-to-form-fields.ts'

export type { FieldCondition } from './form/conditions.ts'
export { toDateInputValue } from './form/field-tree.ts'
export {
	type FieldLayout,
	type FieldUiOptions,
	type FormLayout,
	type FormSection,
	type InputTypeOverride,
	referenceUiOptions,
	type SectionVariant,
} from './form/types.ts'
export type { DraftStorage } from './form/use-form-draft.ts'

export interface DynamicFormProps<T extends z.ZodType> {
	schema: T
	uiOptions?: Record<string, FieldUiOptions | undefined>
	/** Called with the parsed (and `transform`ed) value on a successful submit. */
	onSubmit: (data: z.infer<T>) => void
	defaultValues?: Partial<z.infer<T>>
	submitLabel?: string
	className?: string
	layout?: FormLayout
	gridColumns?: number
	/**
	 * The introspected columns (from Sprout) for this resource. When supplied,
	 * per-field widgets are *upgraded* from column metadata the Zod schema can't
	 * carry — `markdown`, `isFile` (upload), `format: 'color' | 'rating' | …` —
	 * exactly as `<Field>` reads `column` on the display side, so form and
	 * display agree with zero per-field config. Purely additive: without it the
	 * form still infers everything a schema alone can (email/url/password/…).
	 */
	columns?: IntrospectedColumn[]
	/**
	 * Turn a stored file key into a previewable URL. A file column
	 * stores a key, not a URL — the URL expires, the key does not — so previewing
	 * an existing value needs a freshly signed, viewer-bound link that only the
	 * server can mint. Omit it on a client-only render and file fields degrade to
	 * a filename chip.
	 */
	filePreviewUrl?: (key: string) => string
	/** Group fields into sections; when absent the form is one flat group. */
	sections?: FormSection[]
	/** How sections present (ignored in `wizard` mode). Default `panels`. */
	sectionVariant?: SectionVariant
	/** Render `sections` as an ordered, per-step-validated wizard. */
	wizard?: boolean
	/** Show/hide/require fields from sibling values (owned-code predicates). */
	conditions?: FieldCondition[]
	/** Reshape the parsed value just before `onSubmit` (e.g. add a computed key). */
	transform?: (data: z.infer<T>) => unknown
	/** Server-side field errors (422 `fieldErrors`), keyed by field path. Each
	 * clears when its field is edited. */
	serverErrors?: Record<string, string[]>
	/** Render a secondary "Save and add another" submit that resets the form. */
	saveAndAddAnother?: boolean
	/** Warn (via `beforeunload`) when navigating away from a dirty form. */
	dirtyGuard?: boolean
	/** Autosave a draft under this storage key; restored on next mount. */
	autosaveKey?: string
	/** Draft storage (default `localStorage`); injectable for tests. */
	draftStorage?: DraftStorage
}

export function DynamicForm<T extends z.ZodType>({
	schema,
	uiOptions = {},
	onSubmit,
	defaultValues,
	submitLabel = 'Submit',
	className,
	layout = 'vertical',
	gridColumns = 2,
	columns,
	filePreviewUrl,
	sections,
	sectionVariant = 'panels',
	wizard = false,
	conditions,
	transform,
	serverErrors,
	saveAndAddAnother = false,
	dirtyGuard = false,
	autosaveKey,
	draftStorage,
}: DynamicFormProps<T>) {
	const formFields = useMemo(() => zodToFormFields(schema), [schema])
	const columnMap = useMemo(
		() => new Map((columns ?? []).map((c) => [c.name, c])),
		[columns],
	)
	// Fold conditional-`required` predicates into the schema so client, wizard,
	// and submit validation all agree; constraints come from the base schema.
	const validationSchema = useMemo(
		() => refineConditions(schema, conditions),
		[schema, conditions],
	)
	const draft = useFormDraft({ key: autosaveKey, storage: draftStorage })
	const formRef = useRef<HTMLFormElement>(null)

	const resolvedSections = useMemo(
		() => resolveSections(sections, formFields),
		[sections, formFields],
	)
	const isWizard = wizard && resolvedSections.length > 1
	const [step, setStep] = useState(0)
	const lastStep = resolvedSections.length - 1
	// onSubmit runs inside Conform's closure; read the live step from a ref so a
	// stale closure can't submit from a non-final wizard step.
	const stepRef = useRef(step)
	stepRef.current = step

	// Conform's `getZodConstraint` merges a union's branch constraints and loses
	// an outer `.optional()` — so an optional date column (a datetime|date|Date
	// union, the shape `generateValidationSchema` emits) rendered `required`.
	// Our own introspector tracks wrappers correctly; let it veto.
	const constraint = useMemo(() => {
		// Spread into a fresh object: getZodConstraint returns a proxy that
		// silently swallows writes.
		const out: Record<string, { required?: boolean }> = {
			...getZodConstraint(schema as never),
		}
		walkFieldConfigs(formFields, (config) => {
			const entry = out[config.path]
			if ((config.optional || config.nullable) && entry?.required) {
				out[config.path] = { ...entry, required: false }
			}
		})
		return out
	}, [schema, formFields])

	const [form, fields] = useForm<Record<string, unknown>>({
		constraint,
		defaultValue: {
			...collectTopLevelDefaults(formFields),
			...(draft.initial as Record<string, unknown> | undefined),
			...(defaultValues as Record<string, unknown> | undefined),
		} as unknown as Record<string, string | null | undefined>,
		onValidate({ formData }) {
			return parseWithZod(formData, { schema: validationSchema }) as any
		},
		onSubmit(event) {
			event.preventDefault()
			// In a wizard, Enter/implicit submit on a non-final step advances instead.
			if (isWizard && stepRef.current < lastStep) {
				advanceWizard()
				return
			}
			const submission = parseWithZod(new FormData(event.currentTarget), {
				schema: validationSchema,
			})
			if (submission.status !== 'success') return
			const value = submission.value as z.infer<T>
			onSubmit((transform ? transform(value) : value) as z.infer<T>)
			draft.clear()
			const submitter = (event.nativeEvent as SubmitEvent)
				.submitter as HTMLButtonElement | null
			if (submitter?.value === 'add-another') {
				form.reset()
				setStep(0)
			}
		},
	})

	// Current values drive conditional visibility/disabled (reactive via Conform).
	const values = (form.value ?? {}) as FormValues
	const conditionState = resolveConditions(conditions, values)
	useDirtyGuard(form.dirty, dirtyGuard)

	// Server errors: show until the user edits the offending field. `dismissed`
	// resets whenever a fresh `serverErrors` object arrives (a new failed submit).
	const [dismissed, setDismissed] = useState<Set<string>>(() => new Set())
	// biome-ignore lint/correctness/useExhaustiveDependencies: intentionally keyed on the serverErrors identity — a new object means a new submit result.
	useEffect(() => setDismissed(new Set()), [serverErrors])
	const serverErrorFor = (path: string): string[] | undefined =>
		dismissed.has(path) ? undefined : serverErrors?.[path]

	// Autosave the working draft whenever it changes (only once dirty, so we don't
	// persist the untouched defaults).
	// biome-ignore lint/correctness/useExhaustiveDependencies: save/dirty identity is stable enough; we intentionally re-run on value changes.
	useEffect(() => {
		if (autosaveKey && form.dirty) draft.save(values as Record<string, unknown>)
	}, [autosaveKey, form.dirty, form.value])

	function handleFormInput(event: React.FormEvent<HTMLFormElement>) {
		const name = (event.target as HTMLElement & { name?: string }).name
		if (name && serverErrors?.[name] && !dismissed.has(name)) {
			setDismissed((prev) => {
				const next = new Set(prev)
				next.add(name)
				return next
			})
		}
	}

	function advanceWizard(): void {
		const el = formRef.current
		const currentSection = resolvedSections[stepRef.current]
		if (!currentSection) return
		const stepPaths = currentSection.fields.map((f) => f.path)
		if (el) {
			const submission = parseWithZod(new FormData(el), {
				schema: validationSchema,
			})
			const errors =
				submission.status === 'error'
					? ((submission.error ?? {}) as Record<string, string[] | null>)
					: {}
			const blocked = Object.entries(errors).some(
				([key, val]) =>
					val &&
					val.length > 0 &&
					stepPaths.some((p) => fieldOwnsError(p, key)),
			)
			if (blocked) {
				form.validate() // surface the step's errors on-screen
				return
			}
		}
		setStep((s) => Math.min(s + 1, lastStep))
	}

	const ctx: RenderCtx = {
		form,
		uiOptions,
		hidden: conditionState.hidden,
		disabled: conditionState.disabled,
		serverErrorFor,
		columns: columnMap,
		initialValues: defaultValues as Record<string, unknown> | undefined,
		filePreviewUrl,
	}

	const fieldsContainerClass =
		layout === 'horizontal'
			? 'flex flex-wrap gap-4'
			: layout === 'grid'
				? `grid gap-4 grid-cols-1 md:grid-cols-${Math.min(Math.max(gridColumns, 1), 6)}`
				: 'space-y-6'

	const renderFields = (section: ResolvedSection) => (
		<div className={fieldsContainerClass}>
			{section.fields.map((config) => (
				<FieldRenderer
					key={config.path}
					config={config}
					meta={(fields as Record<string, AnyField>)[config.path] as AnyField}
					ctx={ctx}
				/>
			))}
		</div>
	)

	const submitButtons = (
		<div className={cn('flex gap-2', layout === 'grid' && 'col-span-full')}>
			<Button type="submit">{submitLabel}</Button>
			{saveAndAddAnother && (
				<Button
					type="submit"
					name="intent"
					value="add-another"
					className="bg-secondary text-secondary-foreground hover:bg-secondary/80"
				>
					Save and add another
				</Button>
			)}
		</div>
	)

	return (
		<form
			{...getFormProps(form)}
			ref={formRef}
			onInput={handleFormInput}
			className={cn('space-y-6', className)}
		>
			{isWizard ? (
				<WizardBody
					sections={resolvedSections}
					step={step}
					setStep={setStep}
					onNext={advanceWizard}
					renderFields={renderFields}
					submitButtons={submitButtons}
				/>
			) : sections && sections.length > 0 ? (
				<SectionedBody
					sections={resolvedSections}
					variant={sectionVariant}
					renderFields={renderFields}
					footer={submitButtons}
				/>
			) : (
				<>
					{renderFields(resolvedSections[0] as ResolvedSection)}
					{submitButtons}
				</>
			)}
		</form>
	)
}
