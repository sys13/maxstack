import { Link } from "react-router";
import z from "zod/v4";

export const MarketingFooterSchema = z.object({
	appName: z.string(),
	links: z
		.array(
			z.object({
				name: z.string(),
				link: z.string(),
			}),
		)
		.optional(),
});

export type MarketingFooterProps = z.infer<typeof MarketingFooterSchema>;

export default function MarketingFooter({
	appName,
	links,
}: MarketingFooterProps) {
	return (
		<footer className="w-full bg-white border-t py-6 mt-12">
			<div className="container mx-auto flex flex-col md:flex-row items-center justify-between gap-4 px-4">
				{/* Left: Logo and copyright */}
				<div className="flex items-center gap-2 text-muted-foreground text-sm">
					<span className="font-bold text-primary">{appName}</span>
					<span className="hidden md:inline">
						© {new Date().getFullYear()} {appName}. All rights reserved.
					</span>
				</div>
				{/* Center: Navigation Links */}
				<div className="flex gap-6 text-muted-foreground text-sm">
					{links?.map(({ link, name }) => (
						<Link
							key={link + name}
							to={link}
							className="hover:text-primary transition-colors"
						>
							{name}
						</Link>
					))}
				</div>
				{/* Right: Policy Links */}
				<div className="flex gap-4 text-muted-foreground text-xs">
					<Link to="/privacy" className="hover:text-primary transition-colors">
						Privacy Policy
					</Link>
					<Link to="/terms" className="hover:text-primary transition-colors">
						Terms of Service
					</Link>
				</div>
			</div>
		</footer>
	);
}
