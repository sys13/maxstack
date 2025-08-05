import z from 'zod'
import { MAXConfig } from '../../maxstack-parsing/msZod.js'

export const pages: Required<MAXConfig['pages']> = [
	{
		description: 'Landing page for the blog section',
		name: 'Blog Landing',
		routePath: '/blog',
		templateComponents: ['blogLanding'],
	},
	{
		description: 'Individual blog post page',
		name: 'Blog Post',
		routePath: '/blog/:slug',
		templateComponents: ['blogPost'],
	},
	{
		authRequired: true,
		description: 'Create new blog post (requires authentication)',
		name: 'Create Post',
		routePath: '/blog/create',
		templateComponents: ['blogCreate'],
	},
	{
		authRequired: true,
		description: 'Edit existing blog post (requires authentication)',
		name: 'Edit Post',
		routePath: '/blog/edit/:id',
		templateComponents: ['blogEdit'],
	},
]

z.object({
	name: z.string().describe('Name of the page'),
})
