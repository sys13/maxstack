/**
 * Dependent / conditional fields for `<DynamicForm>` — react-admin's
 * `<FormDataConsumer>` expressed as owned-code predicates, never a spec key.
 *
 * A `FieldCondition` targets one field `path` and derives its visibility,
 * disabled state, and dynamic-required-ness from the *whole* current form value.
 * Visibility/disabled are render concerns (see DynamicForm). `required` is a
 * validation concern: it can't live in the static Zod schema (it depends on
 * sibling values), so {@link refineConditions} folds it into the schema as a
 * `superRefine` that runs at parse time — the same schema DynamicForm validates
 * and step-gates against, so client, wizard, and submit all agree.
 *
 * Contract: a field that a condition can *hide* must be optional (or defaulted)
 * in the schema. A hidden field renders no input, so it submits `undefined`; if
 * the schema still required it, the form would be un-submittable with no visible
 * error. Conditional-`required` is the intended way to make an otherwise-optional
 * field mandatory in a given branch.
 */

import type { ZodObject, ZodType } from 'zod'

/** Current form values, as Conform exposes them via `form.value` (strings for
 * native inputs, arrays for multi-value, nested objects/arrays for structural
 * fields). Predicates read whatever they need and are defensive about `undefined`. */
export type FormValues = Record<string, unknown>

export interface FieldCondition {
	/** Dotted path of the field this condition governs (`status`, `address.zip`). */
	field: string
	/** Render the field only when this returns true (default: always visible). */
	visible?: (values: FormValues) => boolean
	/** Disable the field's control when this returns true. */
	disabled?: (values: FormValues) => boolean
	/** Require a (schema-optional) value when this returns true. Enforced at
	 * validation time via {@link refineConditions}, so it gates wizard steps and
	 * final submit identically. */
	required?: (values: FormValues) => boolean
}

/** Read a dotted path (`a.b.c`) out of a nested values object; `undefined` for
 * any missing segment. Array indices in the path (`items.0.qty`) work too. */
export function getByPath(values: unknown, path: string): unknown {
	let current: unknown = values
	for (const segment of path.split('.')) {
		if (current == null || typeof current !== 'object') return undefined
		current = (current as Record<string, unknown>)[segment]
	}
	return current
}

/** A value counts as "present" for conditional-required if it's not nullish and
 * not an empty string / empty array. Mirrors what an empty form control submits. */
function isEmpty(value: unknown): boolean {
	if (value == null || value === '') return true
	if (Array.isArray(value)) return value.length === 0
	return false
}

/**
 * Fold every `required` predicate into the schema as a single `superRefine`.
 * Returns the schema unchanged when no condition declares `required` (so the
 * common case keeps a plain `ZodObject` and pays nothing). The refinement reads
 * the *parsed* data, so coercion has already happened and the check sees real
 * values, not raw form strings.
 */
export function refineConditions<T extends ZodType>(
	schema: T,
	conditions: FieldCondition[] | undefined,
): T {
	const requiredConditions = (conditions ?? []).filter((c) => c.required)
	if (requiredConditions.length === 0) return schema

	// `.superRefine` returns the same ZodObject type (checks are appended in
	// place), so DynamicForm's `getZodConstraint`/`zodToFormFields`/`parseWithZod`
	// all still see an object — no wrapper to peel.
	const object = schema as unknown as ZodObject
	const refined = object.superRefine((data: unknown, ctx) => {
		const values = data as FormValues
		for (const condition of requiredConditions) {
			if (!condition.required?.(values)) continue
			if (isEmpty(getByPath(values, condition.field))) {
				ctx.addIssue({
					code: 'custom',
					path: condition.field.split('.'),
					message: 'Required',
				})
			}
		}
	})
	return refined as unknown as T
}

export interface ResolvedConditionState {
	hidden: Set<string>
	disabled: Set<string>
}

/** Evaluate visibility/disabled predicates against the current values. Pure — the
 * caller (DynamicForm) re-runs it each render off `form.value`. */
export function resolveConditions(
	conditions: FieldCondition[] | undefined,
	values: FormValues,
): ResolvedConditionState {
	const hidden = new Set<string>()
	const disabled = new Set<string>()
	for (const condition of conditions ?? []) {
		if (condition.visible && !condition.visible(values))
			hidden.add(condition.field)
		if (condition.disabled?.(values)) disabled.add(condition.field)
	}
	return { hidden, disabled }
}
