import z from "zod/v4";
import { Badge } from "~/components/ui/badge";
import { Button } from "~/components/ui/button";
import {
	Card,
	CardContent,
	CardDescription,
	CardHeader,
	CardTitle,
} from "~/components/ui/card";
import { Separator } from "~/components/ui/separator";

export const MaxStackWelcomeSchema = z
	.object({
		title: z.string().default("Welcome to MaxStack").optional(),
		subtitle: z
			.string()
			.default("The AI-First Full-Stack Framework")
			.optional(),
		description: z
			.string()
			.default(
				"Build production-ready applications with AI-powered development, built-in templates, and one-click deployment.",
			)
			.optional(),
		showQuickStart: z.boolean().default(true).optional(),
		showNextSteps: z.boolean().default(true).optional(),
		showResources: z.boolean().default(true).optional(),
		showFeatures: z.boolean().default(true).optional(),
	})
	.optional()
	.default({});

export type MaxStackWelcomeProps = z.infer<typeof MaxStackWelcomeSchema>;

export default function MaxStackWelcome({
	title,
	subtitle,
	description,
	showQuickStart = true,
	showNextSteps = true,
	showResources = true,
	showFeatures = true,
}: MaxStackWelcomeProps) {
	const quickStartSteps = [
		{
			step: "1",
			title: "Initialize Project",
			command: "npx maxstack init my-app",
			description: "Create a new MaxStack project with AI-powered scaffolding",
		},
		{
			step: "2",
			title: "Generate Templates",
			command: "npx maxstack gen blog",
			description:
				"Generate routes, schemas, and components with built-in templates",
		},
		{
			step: "3",
			title: "Deploy",
			command: "npm run deploy",
			description: "One-click deployment to Fly.io with automatic migrations",
		},
	];

	const nextSteps = [
		{
			title: "Customize Your App",
			description:
				"Modify maxstack.tsx to define your app structure and let AI generate the implementation",
			icon: "🎨",
		},
		{
			title: "Add Authentication",
			description: "Built-in auth system ready to use out of the box",
			icon: "🔐",
		},
		{
			title: "Explore Templates",
			description:
				"Browse the template gallery for pre-built components and pages",
			icon: "📚",
		},
		{
			title: "Set Up CI/CD",
			description:
				"GitHub Actions integration with automatic testing and deployment",
			icon: "🚀",
		},
	];

	const resources = [
		{
			title: "Documentation",
			description: "Complete guides and API reference",
			url: "/docs",
			icon: "📖",
		},
		{
			title: "Tutorial Videos",
			description: "Step-by-step video walkthroughs",
			url: "/tutorials",
			icon: "🎥",
		},
		{
			title: "Discord Community",
			description: "Join the MaxStack community for support and discussions",
			url: "/discord",
			icon: "💬",
		},
		{
			title: "GitHub Repository",
			description: "View source code, report issues, and contribute",
			url: "https://github.com/maxstack/maxstack",
			icon: "⭐",
		},
		{
			title: "Roadmap",
			description: "See what's coming next in MaxStack development",
			url: "/roadmap",
			icon: "🗺️",
		},
		{
			title: "Live Demo",
			description: "See a Todo app built in 2 minutes with MaxStack",
			url: "/demo",
			icon: "⚡",
		},
	];

	const features = [
		{
			title: "AI-Powered Development",
			description: "Generate code, components, and schemas with AI assistance",
			icon: "🤖",
		},
		{
			title: "Built-in Templates",
			description: "Pre-made components and design system ready to use",
			icon: "🎨",
		},
		{
			title: "One-Click Deployment",
			description: "Deploy to Fly.io with automatic migrations and setup",
			icon: "🚀",
		},
		{
			title: "Full-Stack Ready",
			description:
				"Database, auth, email, and testing configured out of the box",
			icon: "⚡",
		},
	];

	return (
		<div className="maxstack-welcome space-y-12 max-w-6xl mx-auto px-4 py-8">
			<header className="text-center space-y-4">
				<Badge variant="secondary" className="text-sm font-medium">
					v1.0 - AI-First Framework
				</Badge>
				<h1 className="text-4xl md:text-6xl font-bold tracking-tight bg-gradient-to-r from-blue-600 via-purple-600 to-teal-600 bg-clip-text text-transparent">
					{title}
				</h1>
				<h2 className="text-xl md:text-2xl text-muted-foreground font-medium">
					{subtitle}
				</h2>
				<p className="text-lg text-muted-foreground max-w-2xl mx-auto leading-relaxed">
					{description}
				</p>
			</header>

			{showFeatures && (
				<section className="space-y-6">
					<div className="text-center">
						<h3 className="text-3xl font-bold tracking-tight">Why MaxStack?</h3>
						<p className="text-muted-foreground mt-2">
							The tools you need to build faster and smarter
						</p>
					</div>
					<div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-6">
						{features.map((feature) => (
							<Card
								key={feature.title}
								className="transition-all hover:shadow-lg hover:-translate-y-1"
							>
								<CardHeader className="pb-4">
									<div className="text-3xl mb-2">{feature.icon}</div>
									<CardTitle className="text-lg">{feature.title}</CardTitle>
								</CardHeader>
								<CardContent>
									<CardDescription className="text-sm leading-relaxed">
										{feature.description}
									</CardDescription>
								</CardContent>
							</Card>
						))}
					</div>
				</section>
			)}

			{showQuickStart && (
				<section className="space-y-6">
					<div className="text-center">
						<h3 className="text-3xl font-bold tracking-tight">Quick Start</h3>
						<p className="text-muted-foreground mt-2">
							Get up and running in minutes
						</p>
					</div>
					<div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
						{quickStartSteps.map((step, index) => (
							<Card
								key={step.step}
								className="relative overflow-hidden transition-all hover:shadow-lg"
							>
								<CardHeader>
									<div className="flex items-center space-x-3">
										<Badge
											variant="default"
											className="w-8 h-8 rounded-full flex items-center justify-center text-sm font-bold"
										>
											{step.step}
										</Badge>
										<CardTitle className="text-xl">{step.title}</CardTitle>
									</div>
								</CardHeader>
								<CardContent className="space-y-4">
									<div className="bg-muted/50 rounded-lg p-3 font-mono text-sm border">
										<code className="text-foreground">{step.command}</code>
									</div>
									<CardDescription className="leading-relaxed">
										{step.description}
									</CardDescription>
								</CardContent>
								{index < quickStartSteps.length - 1 && (
									<div className="absolute -right-3 top-1/2 transform -translate-y-1/2 hidden lg:block">
										<div className="w-6 h-6 bg-primary/20 rounded-full flex items-center justify-center">
											<svg
												className="w-3 h-3 text-primary"
												fill="none"
												stroke="currentColor"
												viewBox="0 0 24 24"
											>
												<path
													strokeLinecap="round"
													strokeLinejoin="round"
													strokeWidth={2}
													d="M9 5l7 7-7 7"
												/>
											</svg>
										</div>
									</div>
								)}
							</Card>
						))}
					</div>
				</section>
			)}

			{showNextSteps && (
				<section className="space-y-6">
					<div className="text-center">
						<h3 className="text-3xl font-bold tracking-tight">Next Steps</h3>
						<p className="text-muted-foreground mt-2">
							Continue your MaxStack journey
						</p>
					</div>
					<div className="grid grid-cols-1 md:grid-cols-2 gap-6">
						{nextSteps.map((step) => (
							<Card
								key={step.title}
								className="group transition-all hover:shadow-lg hover:-translate-y-1 cursor-pointer"
							>
								<CardHeader>
									<div className="flex items-center space-x-3">
										<div className="text-2xl group-hover:scale-110 transition-transform">
											{step.icon}
										</div>
										<CardTitle className="text-lg group-hover:text-primary transition-colors">
											{step.title}
										</CardTitle>
									</div>
								</CardHeader>
								<CardContent>
									<CardDescription className="leading-relaxed">
										{step.description}
									</CardDescription>
								</CardContent>
							</Card>
						))}
					</div>
				</section>
			)}

			{showResources && (
				<section className="space-y-6">
					<div className="text-center">
						<h3 className="text-3xl font-bold tracking-tight">
							Resources & Community
						</h3>
						<p className="text-muted-foreground mt-2">
							Everything you need to succeed
						</p>
					</div>
					<div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-6">
						{resources.map((resource) => (
							<Card
								key={resource.title}
								className="group transition-all hover:shadow-lg hover:-translate-y-1"
							>
								<CardHeader>
									<div className="flex items-center space-x-3">
										<div className="text-2xl group-hover:scale-110 transition-transform">
											{resource.icon}
										</div>
										<CardTitle className="text-lg group-hover:text-primary transition-colors">
											{resource.title}
										</CardTitle>
									</div>
								</CardHeader>
								<CardContent>
									<CardDescription className="leading-relaxed mb-4">
										{resource.description}
									</CardDescription>
									<Button
										asChild
										variant="outline"
										size="sm"
										className="w-full group-hover:bg-primary group-hover:text-primary-foreground transition-colors"
									>
										<a
											href={resource.url}
											target={
												resource.url.startsWith("http") ? "_blank" : "_self"
											}
											rel={
												resource.url.startsWith("http")
													? "noopener noreferrer"
													: undefined
											}
										>
											Visit Resource
											<svg
												className="w-3 h-3 ml-1"
												fill="none"
												stroke="currentColor"
												viewBox="0 0 24 24"
											>
												<path
													strokeLinecap="round"
													strokeLinejoin="round"
													strokeWidth={2}
													d="M10 6H6a2 2 0 00-2 2v10a2 2 0 002 2h10a2 2 0 002-2v-4M14 4h6m0 0v6m0-6L10 14"
												/>
											</svg>
										</a>
									</Button>
								</CardContent>
							</Card>
						))}
					</div>
				</section>
			)}

			<Separator className="my-12" />

			<footer className="text-center space-y-8">
				<Card className="bg-gradient-to-r from-blue-50 to-purple-50 dark:from-blue-950/20 dark:to-purple-950/20 border-primary/20">
					<CardContent className="pt-6">
						<div className="flex flex-col md:flex-row items-center justify-center gap-4">
							<div className="text-center md:text-left">
								<h4 className="text-xl font-bold text-primary">
									⚡ Build a Todo app in 2 minutes
								</h4>
								<p className="text-muted-foreground">
									Experience the power of AI-driven development
								</p>
							</div>
							<Button size="lg" className="shrink-0">
								Try Live Demo
								<svg
									className="w-4 h-4 ml-2"
									fill="none"
									stroke="currentColor"
									viewBox="0 0 24 24"
								>
									<path
										strokeLinecap="round"
										strokeLinejoin="round"
										strokeWidth={2}
										d="M14.828 14.828a4 4 0 01-5.656 0M9 10h1m4 0h1m-6 4h1m4 0h1m6-6a9 9 0 11-18 0 9 9 0 0118 0z"
									/>
								</svg>
							</Button>
						</div>
					</CardContent>
				</Card>

				<div className="text-sm text-muted-foreground">
					<Badge variant="outline" className="text-xs">
						MaxStack v1.0 - The AI-First Full-Stack Framework
					</Badge>
				</div>
			</footer>
		</div>
	);
}
