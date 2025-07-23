import z from 'zod/v4'
import { Badge } from '~/components/ui/badge'
import { Card, CardContent, CardHeader, CardTitle } from '~/components/ui/card'
import { Separator } from '~/components/ui/separator'

export const variants = ['default'] as const

export const BlogLandingSchema = z.object({
	title: z.string().optional().default('Blog'),
	description: z.string().optional().default('Latest insights and updates'),
	posts: z.array(
		z.object({
			title: z.string(),
			summary: z.string().optional(),
			slug: z.string(),
			publishedAt: z.date().nullable(),
			author: z.string().nullable(),
			tags: z.array(z.string()).optional(),
			coverImage: z.string().optional(),
		}),
	),
	categories: z.array(z.string()).optional(),
	variant: z.enum(variants).default('default').optional(),
})

export type BlogLandingProps = z.infer<typeof BlogLandingSchema>

export default function BlogLanding(props: BlogLandingProps) {
	const {
		title,
		description,
		posts,
		categories = [],
	} = BlogLandingSchema.parse(props)

	return (
		<div className="container mx-auto max-w-6xl px-4 py-8">
			<header className="text-center mb-12">
				<h1 className="text-4xl font-bold tracking-tight mb-4">{title}</h1>
				<p
					data-testid="blog-landing-summary"
					className="text-xl text-muted-foreground max-w-2xl mx-auto"
				>
					{description}
				</p>
			</header>

			{categories.length > 0 && (
				<div className="mb-8">
					<h3 className="text-lg font-semibold mb-4">Categories</h3>
					<div className="flex flex-wrap gap-2">
						{categories.map((category) => (
							<Badge key={category} variant="secondary">
								{category}
							</Badge>
						))}
					</div>
					<Separator className="mt-6" />
				</div>
			)}

			<div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-6">
				{posts.map((post) => (
					<Card
						key={post.title + post.publishedAt}
						className="h-full flex flex-col hover:shadow-lg transition-shadow duration-200"
					>
						{post.coverImage && (
							<div className="aspect-video w-full overflow-hidden rounded-t-xl">
								<img
									src={post.coverImage}
									alt={post.title}
									className="w-full h-full object-cover"
								/>
							</div>
						)}
						<CardHeader className="flex-none">
							<CardTitle className="line-clamp-2">
								<a
									href={`/blog/${post.slug}`}
									className="hover:text-primary transition-colors"
								>
									{post.title}
								</a>
							</CardTitle>
						</CardHeader>
						<CardContent className="flex-1 flex flex-col justify-between">
							<div>
								{post.summary && (
									<p className="text-muted-foreground text-sm mb-4 line-clamp-3">
										{post.summary}
									</p>
								)}
							</div>
							<div className="space-y-3">
								<div className="flex items-center justify-between text-xs text-muted-foreground">
									{post.author && <span>By {post.author}</span>}
									<span>
										{post.publishedAt
											? new Date(post.publishedAt).toLocaleDateString()
											: ''}
									</span>
								</div>
								{post.tags && post.tags.length > 0 && (
									<div className="flex flex-wrap gap-1">
										{post.tags.map((tag) => (
											<Badge key={tag} variant="outline" className="text-xs">
												{tag}
											</Badge>
										))}
									</div>
								)}
							</div>
						</CardContent>
					</Card>
				))}
			</div>
		</div>
	)
}
