/**
 * Cookie-consent banner. Dismissal is client-only, persisted via
 * `@maxstack/ui`'s `PreferenceStore` (task 42) — the same localStorage-backed
 * key/value store `<SavedQueries>`/column-prefs already use — rather than a
 * hand-rolled `localStorage` call, and it works with no `<PreferenceProvider>`
 * mounted (the hook falls back to an unshared store).
 *
 * Accepting also best-effort records the decision server-side via
 * `ConsentService` (`POST /settings/consent`) when the visitor is signed in,
 * so it shows up in that user's GDPR export/consent history — an anonymous
 * visitor only gets the local dismissal, which is all consent tracking can
 * mean before there's an account to attach it to.
 */

import { useHydratedStore } from '@maxstack/ui'
import { useEffect, useRef, useState } from 'react'

export function CookieConsentBanner() {
	// A banner must not flash for someone who already dismissed it, so this is
	// one of the few places that genuinely needs the hydration gate rather than
	// plain `useStore` (which is hydration-safe but flips fallback → persisted
	// after hydration). `useHydratedStore` is the sanctioned form of the
	// hand-rolled `mounted` flag this used to carry, after #137's
	// zombie banner.
	const [dismissed, setDismissed, hydrated] = useHydratedStore(
		'cookieConsent.dismissed',
		false,
	)

	// A fixed bar overlays whatever is underneath it, and on a form long enough
	// to scroll — a 13-field entity — that is the Create button.
	// Clicks landed on the banner and the form looked broken. So the bar reserves
	// its own space in the flow instead of floating over the page. Measured
	// rather than a constant because the bar wraps to two rows on a narrow
	// viewport, and a hardcoded height is wrong at exactly the width where
	// getting it wrong costs the most.
	const barRef = useRef<HTMLElement>(null)
	const [height, setHeight] = useState(0)
	const visible = hydrated && !dismissed
	useEffect(() => {
		const bar = visible ? barRef.current : null
		if (!bar) {
			setHeight(0)
			return
		}
		const measure = () => setHeight(bar.offsetHeight)
		measure()
		if (typeof ResizeObserver === 'undefined') return
		const observer = new ResizeObserver(measure)
		observer.observe(bar)
		return () => observer.disconnect()
	}, [visible])

	if (!visible) return null

	function accept() {
		setDismissed(true)
		fetch('/settings/consent', {
			method: 'POST',
			headers: { 'Content-Type': 'application/json' },
			body: JSON.stringify({ type: 'cookies' }),
		}).catch(() => {
			// Best-effort: an anonymous visitor (or a network hiccup) still gets
			// the banner dismissed locally.
		})
	}

	return (
		<>
			{/* The reserved strip. `aria-hidden` and inert: it is layout, not
			    content, and a screen reader reaching the banner twice would be
			    worse than the overlap it replaces. */}
			<div aria-hidden data-testid="cookie-banner-spacer" style={{ height }} />
			<section
				ref={barRef}
				aria-label="Cookie consent"
				className="fixed inset-x-0 bottom-0 z-50 flex flex-wrap items-center justify-between gap-3 border-t border-border bg-background px-4 py-3 shadow-lg sm:px-6"
			>
				<p className="text-sm text-muted-foreground">
					This app uses cookies for sign-in and preferences. See our{' '}
					<a href="/settings" className="underline underline-offset-2">
						privacy settings
					</a>
					.
				</p>
				<div className="flex items-center gap-2">
					<button
						type="button"
						onClick={() => setDismissed(true)}
						className="h-8 cursor-pointer rounded-md border border-border bg-transparent px-3 text-xs text-muted-foreground hover:text-foreground"
					>
						Dismiss
					</button>
					<button
						type="button"
						onClick={accept}
						className="h-8 cursor-pointer rounded-md bg-primary px-3 text-xs font-medium text-primary-foreground hover:opacity-90"
					>
						Accept
					</button>
				</div>
			</section>
		</>
	)
}
