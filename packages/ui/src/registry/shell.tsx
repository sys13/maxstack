/**
 * App-shell chrome derived from the resource registry (Plan v5 task 41). `<Menu>`
 * renders a sidebar from `registry.menu(caps)` — so a role that can't read a
 * resource never sees its entry — and `<Breadcrumbs>` renders a trail from
 * `breadcrumbsFor`. `<NotFound>`/`<Forbidden>` are the standard error pages a
 * router points its catch-all and access-denied routes at. All take a
 * `linkComponent` so they drop into any router (`<Link>` or a bare `<a>`).
 */

import type { ReactNode } from 'react'
import { cn } from '../lib/cn.ts'
import type { ResourceCapabilities } from '../resource/resource-types.ts'
import {
	breadcrumbsFor,
	type Crumb,
	type MenuEntry,
	type ResourceRegistry,
} from './resource-registry.ts'

type LinkLike = (props: {
	to: string
	children: ReactNode
	className?: string
}) => ReactNode

const DefaultLink: LinkLike = ({ to, children, className }) => (
	<a href={to} className={className}>
		{children}
	</a>
)

export interface MenuProps {
	registry: ResourceRegistry
	/** Per-resource capabilities; entries the session can't access are dropped. */
	capabilities?: Record<string, ResourceCapabilities>
	/** The currently-active resource name (for highlight). */
	active?: string
	linkComponent?: LinkLike
	/** Extra entries appended after the resource entries (dashboard, settings…). */
	extra?: MenuEntry[]
	className?: string
}

export function Menu({
	registry,
	capabilities,
	active,
	linkComponent,
	extra = [],
	className,
}: MenuProps) {
	const Link = linkComponent ?? DefaultLink
	const entries = [...registry.menu(capabilities), ...extra]
	return (
		<nav className={cn('flex flex-col gap-0.5', className)} aria-label="Main">
			{entries.map((entry) => (
				<Link
					key={entry.name}
					to={entry.href}
					className={cn(
						'flex items-center gap-2 rounded-md px-3 py-2 text-sm hover:bg-muted',
						entry.name === active && 'bg-muted font-medium',
					)}
				>
					{entry.icon ? (
						<span aria-hidden className="w-4 text-center">
							{entry.icon}
						</span>
					) : null}
					<span>{entry.label}</span>
				</Link>
			))}
		</nav>
	)
}

export interface BreadcrumbsProps {
	registry: ResourceRegistry
	resource: string
	kind?: 'list' | 'show' | 'create' | 'edit'
	id?: string
	home?: { label: string; href: string } | null
	linkComponent?: LinkLike
	className?: string
}

export function Breadcrumbs({
	registry,
	resource,
	kind,
	id,
	home,
	linkComponent,
	className,
}: BreadcrumbsProps) {
	const Link = linkComponent ?? DefaultLink
	const crumbs: Crumb[] = breadcrumbsFor(registry, resource, { kind, id, home })
	return (
		<nav aria-label="Breadcrumb" className={className}>
			<ol className="flex flex-wrap items-center gap-1 text-sm text-muted-foreground">
				{crumbs.map((crumb, i) => {
					const last = i === crumbs.length - 1
					return (
						// biome-ignore lint/suspicious/noArrayIndexKey: breadcrumbs are a fixed positional trail; the index is the stable identity.
						<li key={`${crumb.label}-${i}`} className="flex items-center gap-1">
							{i > 0 ? (
								<span aria-hidden className="text-muted-foreground/60">
									/
								</span>
							) : null}
							{crumb.href && !last ? (
								<Link
									to={crumb.href}
									className="underline-offset-4 hover:text-foreground hover:underline"
								>
									{crumb.label}
								</Link>
							) : (
								<span className={cn(last && 'font-medium text-foreground')}>
									{crumb.label}
								</span>
							)}
						</li>
					)
				})}
			</ol>
		</nav>
	)
}

export interface ErrorPageProps {
	title?: string
	message?: ReactNode
	/** A call-to-action (e.g. a "Back home" link) rendered below the message. */
	action?: ReactNode
	className?: string
}

/** The catch-all 404 page a router's splat route renders. */
export function NotFound({
	title = 'Page not found',
	message = "The page you're looking for doesn't exist or has moved.",
	action,
	className,
}: ErrorPageProps) {
	return (
		<ErrorState
			code="404"
			title={title}
			message={message}
			action={action}
			className={className}
		/>
	)
}

/** The access-denied page a role-gated route renders (ties to task-35 caps). */
export function Forbidden({
	title = 'Access denied',
	message = "You don't have permission to view this page.",
	action,
	className,
}: ErrorPageProps) {
	return (
		<ErrorState
			code="403"
			title={title}
			message={message}
			action={action}
			className={className}
		/>
	)
}

function ErrorState({
	code,
	title,
	message,
	action,
	className,
}: ErrorPageProps & { code: string }) {
	return (
		<div
			role="alert"
			className={cn(
				'flex flex-col items-center justify-center gap-2 py-16 text-center',
				className,
			)}
		>
			<span className="font-semibold text-4xl text-muted-foreground tabular-nums">
				{code}
			</span>
			<h1 className="font-semibold text-xl">{title}</h1>
			<p className="max-w-md text-muted-foreground text-sm">{message}</p>
			{action ? <div className="mt-2">{action}</div> : null}
		</div>
	)
}
