export const blogFeatureConfig = {
	name: 'blog',
	description: 'A complete blogging system with posts, categories, and tags',
	models: [
		{
			name: 'blogPost',
			description: 'Blog post content and metadata',
			fields: [
				'id',
				'title',
				'slug',
				'summary',
				'content',
				'status',
				'publishedAt',
				'authorId',
				'readingMinutes',
				'coverImage',
				'createdAt',
				'updatedAt',
			],
		},
		{
			name: 'blogCategory',
			description: 'Blog post categories for organization',
			fields: [
				'id',
				'name',
				'description',
				'slug',
				'color',
				'createdAt',
				'updatedAt',
			],
		},
		{
			name: 'blogTag',
			description: 'Tags for blog posts',
			fields: ['id', 'name', 'slug', 'createdAt', 'updatedAt'],
		},
		{
			name: 'blogPostCategory',
			description: 'Many-to-many relationship between posts and categories',
			fields: ['postId', 'categoryId'],
		},
		{
			name: 'blogPostTag',
			description: 'Many-to-many relationship between posts and tags',
			fields: ['postId', 'tagId'],
		},
	],
	pages: [
		{
			name: 'Blog',
			routePath: '/blog',
			description: 'Main blog listing page',
			authRequired: false,
		},
		{
			name: 'BlogPost',
			routePath: '/blog/:slug',
			description: 'Individual blog post page',
			authRequired: false,
		},
		{
			name: 'BlogCategory',
			routePath: '/blog/category/:slug',
			description: 'Blog posts by category',
			authRequired: false,
		},
		{
			name: 'BlogTag',
			routePath: '/blog/tag/:slug',
			description: 'Blog posts by tag',
			authRequired: false,
		},
	],
	components: [
		'BlogPostCard',
		'BlogPostContent',
		'BlogSidebar',
		'CategoryFilter',
		'TagList',
	],
	dependencies: ['user'], // Depends on user system for authors
} as const
