/**
 * The shared Conform bridge for the rich/specialty inputs (task 39): wrap
 * `useControl` into a `[value, setValue, register]` tuple so each widget reads
 * as controlled React state while a single hidden `<input>` (given `register` as
 * its ref) carries the submitted value. Mirrors the pattern in `form-fields.tsx`,
 * factored out because the task-39 controls all need the same string-valued
 * bridge.
 */

import { useControl } from '@conform-to/react/future'

export function useControlValue(defaultValue = '') {
	const control = useControl({ defaultValue })
	const value = control.value ?? ''
	const setValue = (next: string) => control.change(next)
	return [value, setValue, control.register] as const
}
