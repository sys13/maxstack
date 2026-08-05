/**
 * The generic admin's frame — sidebar, providers, content well.
 *
 * Lifted out of `routes/admin.tsx` because it now has two callers. `/admin` and
 * the read-only spec views are still children of a layout route and get it from
 * there; everything below `/admin/:something` is served by a splat that may
 * resolve the path to a *spec-declared project page* instead, and a project page
 * is not framed by this. So the frame is a component the caller wraps content
 * in, rather than a layout route that frames whatever it happens to contain.
 */

import type { ReactNode } from 'react'
import { NavLink } from 'react-router'
import type { AdminChromeData } from './admin.server'

export function AdminChrome({
	groups,
	specNav,
	role,
	children,
}: AdminChromeData & { children: ReactNode }) {
	// No `<DataProvider>` here any more. It used to own one for the
	// admin tree, which was correct in isolation and is how the bug happened: a
	// project page renders outside this frame, so a slot on one had no data
	// context, and the only way out was a second provider with a second cache.
	// The provider is at the root now, so this frame is chrome and nothing else.
	return (
		<div className="flex min-h-screen">
			<AdminSidebar groups={groups} specNav={specNav} role={role} />
			<main className="min-w-0 flex-1 p-8">{children}</main>
		</div>
	)
}

function AdminSidebar({ groups, specNav, role }: AdminChromeData) {
	return (
		<aside className="w-60 shrink-0 border-r border-border bg-muted/40 p-4">
			<div className="font-bold">
				<NavLink to="/admin" className="hover:underline">
					maxstack admin
				</NavLink>
			</div>
			<div className="mt-0.5 mb-4 text-xs text-muted-foreground">
				signed in as {role}
			</div>
			<div className="mb-6">
				<NavLink
					to="/workbench"
					className="text-sm text-muted-foreground hover:text-foreground"
				>
					🛠 Workbench
				</NavLink>
			</div>
			{groups.map((g) => (
				<nav key={g.group} className="mb-4">
					<div className="mb-1 text-[0.7rem] font-medium uppercase tracking-wider text-muted-foreground">
						{g.group}
					</div>
					<ul className="m-0 list-none space-y-0.5 p-0">
						{g.resources.map((r) => (
							<li key={r.name}>
								<NavLink
									to={`/admin/${r.name}`}
									className={({ isActive }) =>
										`block rounded-md px-2 py-1.5 text-sm no-underline hover:bg-accent ${
											isActive ? 'bg-accent font-medium' : ''
										}`
									}
								>
									{r.icon ? `${r.icon} ` : ''}
									{r.label}
								</NavLink>
							</li>
						))}
					</ul>
				</nav>
			))}
			<nav className="mb-4">
				<div className="mb-1 text-[0.7rem] font-medium uppercase tracking-wider text-muted-foreground">
					Spec
				</div>
				<ul className="m-0 list-none space-y-0.5 p-0">
					{[
						{ to: '/admin/spec/product', icon: '📄', label: specNav.product },
						{
							to: '/admin/spec/pages',
							icon: '🗂',
							label: `Pages (${specNav.pages})`,
						},
						{
							to: '/admin/spec/pricing',
							icon: '💳',
							label: `Pricing (${specNav.pricing})`,
						},
					].map((item) => (
						<li key={item.to}>
							<NavLink
								to={item.to}
								className={({ isActive }) =>
									`block rounded-md px-2 py-1.5 text-sm no-underline hover:bg-accent ${
										isActive ? 'bg-accent font-medium' : ''
									}`
								}
							>
								{item.icon} {item.label}
							</NavLink>
						</li>
					))}
				</ul>
			</nav>
		</aside>
	)
}
