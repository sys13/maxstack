/**
 * `<Slot>` — the cross-file extension seam").
 *
 * A generated file renders a named `<Slot>` whose content comes from a stable,
 * user-owned file. This makes a page part-generated / part-hand-written at the
 * MODULE boundary instead of intra-file: the user owns their slot file whole,
 * and the generated file regenerates freely without ever touching it. No AST
 * merge — the moat lives here (and in typed spec-ops).
 *
 * A slot renders, in priority order: an explicit `render` component (what the
 * generator wires from the user's slot file), then `children`, then `fallback`.
 * An unfilled slot renders nothing, so a freshly generated page is valid before
 * the user writes a single line into their slot file.
 */

import type { ComponentType, ReactNode } from 'react'

export interface SlotProps<P extends object = Record<string, never>> {
	/** Slot name — the stable contract between the generated file and the user file. */
	name: string
	/** The user's slot component (from the user-owned `*.slots.tsx` file). */
	render?: ComponentType<P>
	/** Props threaded from the generated page into the user's slot component. */
	props?: P
	/** Inline content, an alternative to `render`. */
	children?: ReactNode
	/** Shown when the slot is unfilled. Defaults to nothing. */
	fallback?: ReactNode
}

export function Slot<P extends object = Record<string, never>>({
	render: Render,
	props,
	children,
	fallback = null,
}: SlotProps<P>): ReactNode {
	if (Render) return <Render {...(props ?? ({} as P))} />
	if (children != null) return <>{children}</>
	return <>{fallback}</>
}
