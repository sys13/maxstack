import z from 'zod/v4'

export const variants = ['default'] as const

export const BlogPostSchema = z.object({
	title: z.string(),
	content: z.string(),
	summary: z.string().optional(),
	author: z.string(),
	publishedAt: z.string(),
	readingMinutes: z.number().optional(),
	tags: z.array(z.string()).optional(),
	categories: z.array(z.string()).optional(),
	coverImage: z.string().optional(),
	variant: z.enum(variants).default('default').optional(),
})

export type BlogPostProps = z.infer<typeof BlogPostSchema>

export default function BlogPost({
	title,
	content,
	summary,
	author,
	publishedAt,
	readingMinutes,
	tags = [],
	categories = [],
	coverImage,
}: BlogPostProps) {
	return (
		<article className="blog-post" data-testid="blog-post">
			<header className="blog-post-header">
				{coverImage && (
					<img
						src={coverImage}
						alt={title}
						className="blog-post-cover"
						data-testid="blog-post-cover"
					/>
				)}
				<div className="blog-post-meta">
					<h1 className="blog-post-title" data-testid="blog-post-title">
						{title}
					</h1>
					{summary && (
						<p className="blog-post-summary" data-testid="blog-post-summary">
							{summary}
						</p>
					)}
					<div className="blog-post-info">
						<span className="blog-post-author" data-testid="blog-post-author">
							By {author}
						</span>
						<span className="blog-post-date" data-testid="blog-post-date">
							{new Date(publishedAt).toLocaleDateString()}
						</span>
						{readingMinutes && (
							<span
								className="blog-post-reading-time"
								data-testid="blog-post-reading-minutes"
							>
								{readingMinutes} min read
							</span>
						)}
					</div>
				</div>
			</header>

			{categories.length > 0 && (
				<div
					className="blog-post-categories"
					data-testid="blog-post-categories"
				>
					<h3>Categories</h3>
					<div className="category-list">
						{categories.map((category) => (
							<span
								key={category}
								className="category-tag"
								data-testid="blog-post-category"
							>
								{category}
							</span>
						))}
					</div>
				</div>
			)}

			<div className="blog-post-content" data-testid="blog-post-content">
				{/** biome-ignore lint/security/noDangerouslySetInnerHtml: sanitized */}
				<div dangerouslySetInnerHTML={{ __html: content }} />
			</div>

			{tags.length > 0 && (
				<footer className="blog-post-footer">
					<div className="blog-post-tags" data-testid="blog-post-tags">
						<h3>Tags</h3>
						<div className="tag-list">
							{tags.map((tag) => (
								<span
									key={tag}
									className="tag-badge"
									data-testid="blog-post-tag"
								>
									{tag}
								</span>
							))}
						</div>
					</div>
				</footer>
			)}
		</article>
	)
}
