/**
 * `<PreferencesForm>` — the *derived* settings form.
 *
 * A settings page is the classic place where the same three facts get written
 * four times: a column, a form field, a loader mapping, an action mapping. This
 * component removes three of the four. It renders whatever fields it is handed —
 * one input per declaration, grouped as declared, typed by `type` — so adding a
 * preference is a declaration and nothing else, and the page below has no
 * knowledge of what a "digest frequency" is.
 *
 * Presentation-pure, like `<History>`/`<ResourceList>`: the fields are a prop.
 * The types are structurally `@maxstack/features/preferences`'s
 * `PreferenceGroupView` / `PreferenceFieldView`, restated locally so this
 * package stays free of a features dependency (the architecture boundary in
 * `scripts/boundaries.config.json`) — a loader hands the service's output
 * straight through.
 *
 * Two behaviors worth stating, because both are easy to get wrong and neither
 * is visible in the markup:
 *
 *   - **An unchecked checkbox submits nothing.** Every boolean field renders a
 *     hidden `off` input before its checkbox, so unchecking one submits `off`
 *     rather than dropping the key — otherwise "turn this off and save" would
 *     silently leave the old value in place.
 *   - **An inherited value is labeled.** A field whose value came from the
 *     organization says so, so a member can tell "my choice" from "my org's
 *     default" — the distinction the storage shape exists to preserve.
 */

import type { ReactNode } from 'react'
import { cn } from '../lib/cn.ts'

export type PreferenceFieldType = 'boolean' | 'string' | 'number' | 'enum'

export type PreferenceFieldSource = 'user' | 'organization' | 'default'

export interface PreferenceFieldOption {
	label: string
	value: string
}

/** One declared preference, resolved for the viewer. */
export interface PreferenceField {
	key: string
	label: string
	description?: string
	type: PreferenceFieldType
	options?: PreferenceFieldOption[]
	group: string
	value: boolean | string | number
	source: PreferenceFieldSource
	/** False renders the field disabled — the read-only view a member gets of
	 * their organization's defaults. */
	editable: boolean
}

export interface PreferenceGroup {
	group: string
	fields: PreferenceField[]
}

export interface PreferencesFormProps {
	groups: PreferenceGroup[]
	/** Disables every input (a submit in flight). */
	busy?: boolean
	/** Rendered when there are no declarations at all. */
	emptyState?: ReactNode
	className?: string
}

const INPUT_CLASS =
	'h-9 rounded-md border border-border bg-transparent px-3 text-sm disabled:opacity-50'

function SourceNote({ source }: { source: PreferenceFieldSource }) {
	if (source !== 'organization') return null
	return (
		<span className="text-xs text-muted-foreground">
			from your organization
		</span>
	)
}

function Field({ field, busy }: { field: PreferenceField; busy?: boolean }) {
	const disabled = busy || !field.editable

	if (field.type === 'boolean') {
		return (
			<div className="flex flex-col gap-1">
				{/* Submitted when the box is unchecked; the checkbox overrides it.
				    Outside the <label> so the label names only the checkbox. */}
				<input type="hidden" name={field.key} value="off" />
				<label className="flex items-center gap-2 text-sm">
					<input
						type="checkbox"
						name={field.key}
						value="on"
						defaultChecked={field.value === true}
						disabled={disabled}
					/>
					{field.label}
					<SourceNote source={field.source} />
				</label>
				{field.description ? (
					<p className="pl-6 text-xs text-muted-foreground">
						{field.description}
					</p>
				) : null}
			</div>
		)
	}

	// `htmlFor` rather than wrapping: the control is behind a conditional, which
	// a wrapping label cannot be statically associated with.
	const id = `preference-${field.key}`
	return (
		<div className="flex flex-col gap-1">
			<label
				htmlFor={id}
				className="flex items-center gap-2 text-xs text-muted-foreground"
			>
				{field.label}
				<SourceNote source={field.source} />
			</label>
			{field.type === 'enum' ? (
				<select
					id={id}
					name={field.key}
					defaultValue={String(field.value)}
					disabled={disabled}
					className={INPUT_CLASS}
				>
					{(field.options ?? []).map((option) => (
						<option key={option.value} value={option.value}>
							{option.label}
						</option>
					))}
				</select>
			) : (
				<input
					id={id}
					name={field.key}
					type={field.type === 'number' ? 'number' : 'text'}
					defaultValue={String(field.value)}
					disabled={disabled}
					className={INPUT_CLASS}
				/>
			)}
			{field.description ? (
				<span className="text-xs text-muted-foreground">
					{field.description}
				</span>
			) : null}
		</div>
	)
}

export function PreferencesForm({
	groups,
	busy,
	emptyState,
	className,
}: PreferencesFormProps) {
	if (groups.length === 0) return <>{emptyState ?? null}</>
	return (
		<div className={cn('flex flex-col gap-6', className)}>
			{groups.map((group) => (
				<fieldset key={group.group} className="flex flex-col gap-3">
					<legend className="text-sm font-medium">{group.group}</legend>
					{group.fields.map((field) => (
						<Field key={field.key} field={field} busy={busy} />
					))}
				</fieldset>
			))}
		</div>
	)
}
