import z from 'zod/v4'

export const variants = ['default'] as const

export const BlogLandingSchema = z.object({
	title: z.string().default('Blog'),
	description: z.string().default('Latest insights and updates'),
	posts: z
		.array(
			z.object({
				title: z.string(),
				summary: z.string(),
				slug: z.string(),
				publishedAt: z.string(),
				author: z.string().optional(),
				readingMinutes: z.number().optional(),
				tags: z.array(z.string()).optional(),
				coverImage: z.string().optional(),
			}),
		)
		.optional(),
	categories: z.array(z.string()).optional(),
	variant: z.enum(variants).default('default').optional(),
})

export type BlogLandingProps = z.infer<typeof BlogLandingSchema>

export default function BlogLanding(props: Partial<BlogLandingProps>) {
	const {
		title = 'Blog',
		description = 'Latest insights and updates',
		posts = [],
		categories = [],
	} = BlogLandingSchema.parse(props)

	return (
		<div className="blog-landing">
			<header className="blog-header">
				<h1>{title}</h1>
				<p data-testid="blog-landing-summary">{description}</p>
			</header>

			{categories.length > 0 && (
				<div className="blog-categories">
					<h3>Categories</h3>
					<div className="category-tags">
						{categories.map((category) => (
							<span key={category} className="category-tag">
								{category}
							</span>
						))}
					</div>
				</div>
			)}

			<div className="blog-posts">
				{posts.map((post) => (
					<article
						key={post.title + post.publishedAt}
						className="blog-post-card"
					>
						{post.coverImage && (
							<img
								src={post.coverImage}
								alt={post.title}
								className="post-image"
							/>
						)}
						<div className="post-content">
							<h2>
								<a href={`/blog/${post.slug}`}>{post.title}</a>
							</h2>
							<p className="post-summary">{post.summary}</p>
							<div className="post-meta">
								{post.author && (
									<span className="author">By {post.author}</span>
								)}
								<span className="date">
									{new Date(post.publishedAt).toLocaleDateString()}
								</span>
								{post.readingMinutes && (
									<span className="reading-time">
										{post.readingMinutes} min read
									</span>
								)}
							</div>
							{post.tags && post.tags.length > 0 && (
								<div className="post-tags">
									{post.tags.map((tag) => (
										<span key={tag} className="tag">
											{tag}
										</span>
									))}
								</div>
							)}
						</div>
					</article>
				))}
			</div>
		</div>
	)
}
