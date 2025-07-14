import { useState } from 'react'
import { Link } from 'react-router'
import z from 'zod/v4'
import { Button } from '~/components/ui/button'
import { authClient } from '~/lib/auth-client'
import { cn } from '~/lib/utils'

export const MarketingNavSchema = z.object({
	appName: z.string(),
	links: z
		.array(
			z.object({
				name: z.string(),
				link: z.string(),
			}),
		)
		.optional(),
})

export type MarketingNavProps = z.infer<typeof MarketingNavSchema>

export default function MarketingNav({ appName, links }: MarketingNavProps) {
	const [mobileMenuOpen, setMobileMenuOpen] = useState(false)
	const user = authClient.useSession().data?.user
	return (
		<nav className={cn('w-full bg-white border-b sticky top-0 z-50')}>
			<div className="w-full md:max-w-none md:w-full flex items-center justify-between py-4 px-4 mx-auto">
				{/* Logo */}
				<Link
					to="/"
					className="flex items-center gap-2 font-bold text-xl text-primary"
				>
					<span>{appName}</span>
				</Link>
				{/* Navigation Links (Desktop) */}
				<div className="hidden md:flex gap-8 items-center md:ml-8 md:mr-auto">
					{links?.map(({ link, name }) => (
						<Link
							to={link}
							key={link + name}
							className="text-muted-foreground hover:text-primary transition-colors"
						>
							{name}
						</Link>
					))}
				</div>
				{/* Hamburger Button (Mobile) */}
				<button
					className="md:hidden flex items-center px-2 py-1 border rounded text-primary focus:outline-none"
					onClick={() => setMobileMenuOpen((open) => !open)}
					type="button"
					aria-label="Open navigation menu"
				>
					<svg
						className="h-6 w-6"
						fill="none"
						stroke="currentColor"
						viewBox="0 0 24 24"
						xmlns="http://www.w3.org/2000/svg"
					>
						<path
							strokeLinecap="round"
							strokeLinejoin="round"
							strokeWidth={2}
							d="M4 6h16M4 12h16M4 18h16"
						/>
					</svg>
				</button>
				{/* Mobile Menu Dropdown */}
				{mobileMenuOpen && (
					<div className="absolute top-full left-0 w-full bg-white border-b shadow-md flex flex-col md:hidden z-50 animate-fade-in">
						{links?.map(({ link, name }) => (
							<Link
								to={link}
								key={link + name}
								className="px-4 py-3 text-muted-foreground hover:text-primary border-b last:border-b-0 transition-colors"
								onClick={() => setMobileMenuOpen(false)}
							>
								{name}
							</Link>
						))}
						<div className="flex flex-col gap-2 px-4 py-3">
							{user ? (
								<Link to="/dashboard" onClick={() => setMobileMenuOpen(false)}>
									<Button size="sm" className="w-full">
										Dashboard
									</Button>
								</Link>
							) : (
								<>
									<Link to="/login" onClick={() => setMobileMenuOpen(false)}>
										<Button variant="ghost" size="sm" className="w-full">
											Log in
										</Button>
									</Link>
									<Link to="/signup" onClick={() => setMobileMenuOpen(false)}>
										<Button size="sm" className="w-full">
											Get Started
										</Button>
									</Link>
								</>
							)}
						</div>
					</div>
				)}
				{/* CTA Buttons (Desktop) */}
				<div className="hidden md:flex gap-2">
					{user ? (
						<Link to="/dashboard">
							<Button size="sm">Dashboard</Button>
						</Link>
					) : (
						<>
							<Link to="/login">
								<Button variant="ghost" size="sm">
									Log in
								</Button>
							</Link>
							<Link to="/signup">
								<Button size="sm">Get Started</Button>
							</Link>
						</>
					)}
				</div>
			</div>
		</nav>
	)
}
