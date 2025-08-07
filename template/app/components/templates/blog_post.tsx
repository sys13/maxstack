import z from 'zod'

export const variants = ['default'] as const

export const BlogPostSchema = z.object({
	post: z.object({
		title: z.string(),
		content: z.string(),
		summary: z.string().optional(),
		author: z.string().optional(),
		publishedAt: z.date().nullable(),
		tags: z.array(z.string()).optional(),
		categories: z.array(z.string()).optional(),
		coverImage: z.string().optional(),
		variant: z.enum(variants).default('default').optional(),
	}),
})

export type BlogPostProps = z.infer<typeof BlogPostSchema>

export default function BlogPost({
	post: {
		title,
		content,
		summary,
		author,
		publishedAt,
		tags = [],
		categories = [],
		coverImage,
	},
}: BlogPostProps) {
	return (
		<article
			className="max-w-4xl mx-auto px-4 py-8 lg:px-8"
			data-testid="blog-post"
		>
			<header className="mb-8">
				{coverImage && (
					<img
						src={coverImage}
						alt={title}
						className="w-full h-64 md:h-96 object-cover rounded-xl mb-8 shadow-lg"
						data-testid="blog-post-cover"
					/>
				)}
				<div className="space-y-4">
					<h1
						className="text-3xl md:text-4xl lg:text-5xl font-bold tracking-tight text-foreground leading-tight"
						data-testid="blog-post-title"
					>
						{title}
					</h1>
					{summary && (
						<p
							className="text-lg md:text-xl text-muted-foreground leading-relaxed"
							data-testid="blog-post-summary"
						>
							{summary}
						</p>
					)}
					<div className="flex flex-col sm:flex-row sm:items-center gap-2 sm:gap-4 text-sm text-muted-foreground border-l-4 border-primary pl-4">
						{author && (
							<span
								className="font-medium text-foreground"
								data-testid="blog-post-author"
							>
								By {author}
							</span>
						)}
						{publishedAt && (
							<span data-testid="blog-post-date">
								{new Date(publishedAt).toLocaleDateString('en-US', {
									year: 'numeric',
									month: 'long',
									day: 'numeric',
								})}
							</span>
						)}
					</div>
				</div>
			</header>

			{categories.length > 0 && (
				<div
					className="mb-8 p-4 bg-secondary/30 rounded-lg border"
					data-testid="blog-post-categories"
				>
					<h3 className="text-lg font-semibold mb-3 text-foreground">
						Categories
					</h3>
					<div className="flex flex-wrap gap-2">
						{categories.map((category) => (
							<span
								key={category}
								className="inline-flex items-center px-3 py-1 rounded-full text-sm font-medium bg-primary text-primary-foreground hover:bg-primary/80 transition-colors"
								data-testid="blog-post-category"
							>
								{category}
							</span>
						))}
					</div>
				</div>
			)}

			<div
				className="text-foreground leading-relaxed"
				data-testid="blog-post-content"
			>
				<div
					className="space-y-6 [&>h1]:text-2xl [&>h1]:font-bold [&>h1]:mb-4 [&>h2]:text-xl [&>h2]:font-semibold [&>h2]:mb-3 [&>h3]:text-lg [&>h3]:font-medium [&>h3]:mb-2 [&>p]:mb-4 [&>p]:leading-7 [&>a]:text-primary [&>a]:underline [&>a]:hover:text-primary/80 [&>ul]:list-disc [&>ul]:ml-6 [&>ul]:mb-4 [&>ol]:list-decimal [&>ol]:ml-6 [&>ol]:mb-4 [&>li]:mb-1 [&>blockquote]:border-l-4 [&>blockquote]:border-primary [&>blockquote]:pl-4 [&>blockquote]:italic [&>blockquote]:text-muted-foreground [&>pre]:bg-muted [&>pre]:p-4 [&>pre]:rounded-lg [&>pre]:overflow-x-auto [&>code]:bg-muted [&>code]:px-1 [&>code]:py-0.5 [&>code]:rounded [&>code]:text-sm"
					// biome-ignore lint/security/noDangerouslySetInnerHtml: markdown content
					dangerouslySetInnerHTML={{ __html: content }}
				/>
			</div>

			{tags.length > 0 && (
				<footer className="mt-12 pt-8 border-t border-border">
					<div className="space-y-4" data-testid="blog-post-tags">
						<h3 className="text-lg font-semibold text-foreground">Tags</h3>
						<div className="flex flex-wrap gap-2">
							{tags.map((tag) => (
								<span
									key={tag}
									className="inline-flex items-center px-2.5 py-1 rounded-md text-xs font-medium bg-muted text-muted-foreground hover:bg-muted/80 transition-colors border border-border"
									data-testid="blog-post-tag"
								>
									#{tag}
								</span>
							))}
						</div>
					</div>
				</footer>
			)}
		</article>
	)
}
