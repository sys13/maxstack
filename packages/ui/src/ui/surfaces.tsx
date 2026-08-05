/**
 * Layout and feedback primitives — the non-form half of the shadcn vocabulary
 *.
 *
 * Same rules as `primitives.tsx`: plain native elements, theme tokens only, no
 * new dependencies and no registry CLI. These are not new capability, they are
 * the class strings the app surfaces were already retyping — the destructive
 * error box appeared verbatim in thirteen files, the "button" that had to be a
 * `<Link>` in about ten, and every table re-declared its own header styling. A
 * primitive nobody imports is dead weight; each of these earns its place by
 * replacing duplication that already exists.
 *
 * Composition over configuration, deliberately: `Card` does not take a `title`
 * prop, it takes children, so a caller who needs something the prop never
 * anticipated writes JSX instead of waiting for a new prop.
 */

import type * as React from 'react'
import { cn } from '../lib/cn.ts'

// --- feedback ---------------------------------------------------------------

/**
 * One variant per thing the palette can name.
 *
 * `success` and `warning` were cut from the first version of this file because
 * the theme had no token for them, and a `bg-success/10` resolving to nothing
 * renders as an unstyled box — a variant that silently does nothing is worse
 * than one that does not exist. The tokens now exist in every preset and in the
 * runtime stylesheet (`theme/presets.ts`), so the variants are expressible.
 * Anything past these four still is not: invent a token before a variant.
 */
export type AlertVariant = 'info' | 'success' | 'warning' | 'destructive'

const ALERT_VARIANT: Record<AlertVariant, string> = {
	info: 'border-border bg-muted/40 text-foreground',
	success: 'border-success/50 bg-success/10 text-success',
	warning: 'border-warning/50 bg-warning/10 text-warning',
	destructive: 'border-destructive/50 bg-destructive/10 text-destructive',
}

/**
 * A bordered message block.
 *
 * `role` is left to the caller rather than derived from the variant: whether a
 * message interrupts a screen reader is a question about *this* message's
 * urgency, not about its colour. A validation summary the user just caused
 * wants `role="alert"`; a standing notice wants nothing.
 */
export function Alert({
	className,
	variant = 'info',
	...props
}: React.ComponentProps<'div'> & { variant?: AlertVariant }) {
	return (
		<div
			className={cn(
				'rounded-md border p-3 text-sm',
				ALERT_VARIANT[variant],
				className,
			)}
			{...props}
		/>
	)
}

export function AlertTitle({
	className,
	...props
}: React.ComponentProps<'div'>) {
	return <div className={cn('mb-1 font-medium', className)} {...props} />
}

/** Same palette constraint as {@link AlertVariant} — no invented tokens. */
export type BadgeVariant =
	| 'default'
	| 'outline'
	| 'success'
	| 'warning'
	| 'destructive'
	| 'primary'

const BADGE_VARIANT: Record<BadgeVariant, string> = {
	default: 'bg-muted text-muted-foreground',
	outline: 'border border-border text-muted-foreground',
	success: 'bg-success/10 text-success',
	warning: 'bg-warning/10 text-warning',
	destructive: 'bg-destructive/10 text-destructive',
	primary: 'bg-primary text-primary-foreground',
}

/** A small status pill — a count, a state, a tag. */
export function Badge({
	className,
	variant = 'default',
	...props
}: React.ComponentProps<'span'> & { variant?: BadgeVariant }) {
	return (
		<span
			className={cn(
				'inline-flex items-center rounded-full px-2 py-0.5 text-xs font-medium',
				BADGE_VARIANT[variant],
				className,
			)}
			{...props}
		/>
	)
}

// --- layout -----------------------------------------------------------------

export function Card({ className, ...props }: React.ComponentProps<'div'>) {
	return (
		<div
			className={cn('rounded-md border border-border bg-card', className)}
			{...props}
		/>
	)
}

export function CardHeader({
	className,
	...props
}: React.ComponentProps<'div'>) {
	return <div className={cn('flex flex-col gap-1 p-4', className)} {...props} />
}

export function CardTitle({ className, ...props }: React.ComponentProps<'h3'>) {
	return <h3 className={cn('font-medium leading-none', className)} {...props} />
}

export function CardDescription({
	className,
	...props
}: React.ComponentProps<'p'>) {
	return (
		<p className={cn('text-sm text-muted-foreground', className)} {...props} />
	)
}

export function CardContent({
	className,
	...props
}: React.ComponentProps<'div'>) {
	return <div className={cn('p-4 pt-0', className)} {...props} />
}

/**
 * A rule between sections.
 *
 * An `<hr>` rather than a styled `<div role="separator">`, which is the shape
 * this started as: ARIA's `separator` role is the *focusable splitter* (it wants
 * `tabIndex` and `aria-valuenow`), so hand-rolling it produces a control that
 * claims to be draggable and is not. `<hr>` already means exactly this and needs
 * no ARIA at all — `border-0` because the rule is drawn as a background, so it
 * stays one device pixel at any zoom.
 *
 * Decorative by default: a line that exists to give the eye a break announces
 * nothing useful, and `role="none"` drops it from the accessibility tree. Pass
 * `decorative={false}` when it genuinely separates two regions.
 */
export function Separator({
	className,
	orientation = 'horizontal',
	decorative = true,
	...props
}: React.ComponentProps<'hr'> & {
	orientation?: 'horizontal' | 'vertical'
	decorative?: boolean
}) {
	return (
		<hr
			{...(decorative
				? { role: 'none' as const }
				: orientation === 'vertical'
					? { 'aria-orientation': 'vertical' as const }
					: {})}
			className={cn(
				'shrink-0 border-0 bg-border',
				orientation === 'horizontal' ? 'h-px w-full' : 'h-full w-px',
				className,
			)}
			{...props}
		/>
	)
}

// --- table ------------------------------------------------------------------

/**
 * The table set.
 *
 * `Table` ships its own horizontal scroll container, because the failure it
 * prevents is the one every hand-rolled table here has hit: a wide data table
 * widening the page instead of scrolling inside it, which on a narrow screen
 * makes the *whole layout* pan sideways.
 */
export function Table({ className, ...props }: React.ComponentProps<'table'>) {
	return (
		<div className="w-full overflow-x-auto">
			<table
				className={cn('w-full caption-bottom text-sm', className)}
				{...props}
			/>
		</div>
	)
}

export function TableHeader({
	className,
	...props
}: React.ComponentProps<'thead'>) {
	return <thead className={cn('[&_tr]:border-b', className)} {...props} />
}

export function TableBody({
	className,
	...props
}: React.ComponentProps<'tbody'>) {
	return (
		<tbody className={cn('[&_tr:last-child]:border-0', className)} {...props} />
	)
}

export function TableRow({ className, ...props }: React.ComponentProps<'tr'>) {
	return (
		<tr
			className={cn(
				'border-b border-border transition-colors hover:bg-muted/50',
				className,
			)}
			{...props}
		/>
	)
}

export function TableHead({ className, ...props }: React.ComponentProps<'th'>) {
	return (
		<th
			className={cn(
				'h-10 px-3 text-left align-middle font-medium text-muted-foreground',
				className,
			)}
			{...props}
		/>
	)
}

export function TableCell({ className, ...props }: React.ComponentProps<'td'>) {
	return <td className={cn('px-3 py-2 align-middle', className)} {...props} />
}

export function TableCaption({
	className,
	...props
}: React.ComponentProps<'caption'>) {
	return (
		<caption
			className={cn('mt-3 text-sm text-muted-foreground', className)}
			{...props}
		/>
	)
}
