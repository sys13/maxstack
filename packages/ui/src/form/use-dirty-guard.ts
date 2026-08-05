/**
 * `useDirtyGuard` — warn before the browser unloads a form with unsaved edits.
 *
 * Framework-agnostic on purpose: `@maxstack/ui` has no router dependency, so the
 * guard hooks the native `beforeunload` event (covers tab close, reload, and
 * hard navigation). A router-level "block SPA navigation" guard is the app's job;
 * this covers the browser-level case every app shares. The listener is only
 * attached while `when` is true, so a pristine form adds no `beforeunload`
 * handler at all (and thus no bfcache penalty).
 */

import { useEffect } from 'react'

/**
 * @param when   attach the guard only while this is true (typically `form.dirty`).
 * @param enabled master switch — pass the `dirtyGuard` prop so the feature is opt-in.
 */
export function useDirtyGuard(when: boolean, enabled = true): void {
	useEffect(() => {
		if (!enabled || !when) return
		if (typeof window === 'undefined') return
		const handler = (event: BeforeUnloadEvent) => {
			event.preventDefault()
			// Legacy browsers require a truthy returnValue to trigger the prompt; the
			// string itself is ignored by modern browsers (they show a generic
			// message), so we don't bother customizing it.
			event.returnValue = ''
			return ''
		}
		window.addEventListener('beforeunload', handler)
		return () => window.removeEventListener('beforeunload', handler)
	}, [when, enabled])
}
