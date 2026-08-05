/**
 * shadcn-style primitives on plain native elements. Text-like inputs, textarea,
 * and labels are native by design (this is exactly what shadcn's Input/Textarea
 * are) — Conform drives them directly via `getInputProps`/`getTextareaProps`.
 * The genuinely non-native widgets (select, checkbox, radio) live in their own
 * Base UI files and use the `useControl` bridge.
 */

import type * as React from 'react'
import { cn } from '../lib/cn.ts'

export function Input({ className, ...props }: React.ComponentProps<'input'>) {
	return (
		<input
			className={cn(
				'flex h-9 w-full rounded-md border border-input bg-transparent px-3 py-1 text-sm shadow-sm transition-colors placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring disabled:cursor-not-allowed disabled:opacity-50',
				className,
			)}
			{...props}
		/>
	)
}

export function Textarea({
	className,
	...props
}: React.ComponentProps<'textarea'>) {
	return (
		<textarea
			className={cn(
				'flex min-h-16 w-full rounded-md border border-input bg-transparent px-3 py-2 text-sm shadow-sm placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring disabled:cursor-not-allowed disabled:opacity-50',
				className,
			)}
			{...props}
		/>
	)
}

export function Label({ className, ...props }: React.ComponentProps<'label'>) {
	return (
		// biome-ignore lint/a11y/noLabelWithoutControl: reusable primitive; callers associate a control via htmlFor
		<label
			className={cn(
				'text-sm font-medium leading-none peer-disabled:cursor-not-allowed peer-disabled:opacity-70',
				className,
			)}
			{...props}
		/>
	)
}

export type ButtonVariant =
	| 'primary'
	| 'outline'
	| 'destructive'
	| 'ghost'
	| 'link'
export type ButtonSize = 'sm' | 'md' | 'icon'

// `cursor-pointer` is here rather than at the call sites: Tailwind v4 dropped
// the browser default on `<button>`, and every hand-rolled button in the app
// had re-added it — a primitive that makes a caller remember that is a
// primitive they route around. `disabled:pointer-events-none` already stops it
// applying to a disabled control.
const BUTTON_BASE =
	'inline-flex cursor-pointer items-center justify-center gap-2 rounded-md text-sm font-medium no-underline transition-colors focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring disabled:pointer-events-none disabled:opacity-50'

const BUTTON_VARIANT: Record<ButtonVariant, string> = {
	primary: 'bg-primary text-primary-foreground shadow hover:bg-primary/90',
	outline:
		'border border-border bg-transparent hover:bg-accent hover:text-accent-foreground',
	destructive:
		'border border-destructive/50 bg-transparent text-destructive hover:bg-destructive/10',
	ghost: 'bg-transparent hover:bg-accent hover:text-accent-foreground',
	link: 'bg-transparent text-primary underline-offset-4 hover:underline',
}

const BUTTON_SIZE: Record<ButtonSize, string> = {
	sm: 'h-8 px-3',
	md: 'h-9 px-4 py-2',
	icon: 'h-9 w-9',
}

/**
 * The button's classes without the button — for the cases where the *element*
 * has to be something else.
 *
 * A router `<Link>` styled as a button is the common one, and it is why these
 * class strings kept being retyped by hand across the app surfaces: `Button`
 * renders a `<button>`, and a `<button>` cannot navigate. `link` is the inverse
 * variant: a real button that should read as a link.
 */
export function buttonVariants({
	variant = 'primary',
	size = 'md',
	className,
}: {
	variant?: ButtonVariant
	size?: ButtonSize
	className?: string
} = {}): string {
	return cn(
		BUTTON_BASE,
		BUTTON_VARIANT[variant],
		// A link-styled button keeps its text on the baseline instead of being
		// padded into a control-sized box.
		variant === 'link' ? 'h-auto p-0' : BUTTON_SIZE[size],
		className,
	)
}

export function Button({
	className,
	type = 'button',
	variant = 'primary',
	size = 'md',
	...props
}: React.ComponentProps<'button'> & {
	variant?: ButtonVariant
	size?: ButtonSize
}) {
	return (
		<button
			type={type}
			className={buttonVariants({ variant, size, className })}
			{...props}
		/>
	)
}
