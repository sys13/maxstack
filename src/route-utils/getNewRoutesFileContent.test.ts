import { describe, expect, it } from 'vitest'

import type { Page } from '../maxstack-parsing/msZod.js'

import { getNewRoutesFileContent } from './getNewRoutesFileContent.js'

describe('getNewRoutesFileContent', () => {
	it('should generate basic routes file with empty pages array', () => {
		const newPages: Page[] = []
		const result = getNewRoutesFileContent(newPages)

		expect(result)
			.toBe(`import { index, route, type RouteConfig } from '@react-router/dev/routes'

export default [
	index('routes/home.tsx'),
	route('*', './catchall.tsx'),
] satisfies RouteConfig
`)
	})

	it('should generate routes for pages with custom routePath', () => {
		const newPages: Page[] = [
			{
				name: 'Home',
				routePath: '/',
			},
			{
				name: 'About',
				routePath: '/about',
			},
			{
				name: 'Contact',
				routePath: '/contact',
			},
		]

		const result = getNewRoutesFileContent(newPages)

		expect(result)
			.toBe(`import { index, route, type RouteConfig } from '@react-router/dev/routes'

export default [
	index('routes/home.tsx'),
	route('/about', 'routes/about.tsx'),
	route('/contact', 'routes/contact.tsx'),
	route('*', './catchall.tsx'),
] satisfies RouteConfig
`)
	})

	it('should generate routes for pages without routePath (using name)', () => {
		const newPages: Page[] = [
			{
				name: 'Dashboard',
				routePath: '/dashboard',
			},
			{
				name: 'User Profile',
				routePath: '/user-profile',
			},
		]

		const result = getNewRoutesFileContent(newPages)

		expect(result)
			.toBe(`import { index, route, type RouteConfig } from '@react-router/dev/routes'

export default [
	route('/dashboard', 'routes/dashboard.tsx'),
	route('/user-profile', 'routes/user-profile.tsx'),
	route('*', './catchall.tsx'),
] satisfies RouteConfig
`)
	})

	it('should auto-generate routePath from name when not provided', () => {
		const newPages: Page[] = [
			{
				name: 'My Custom Page',
				routePath: '',
			},
		]

		const result = getNewRoutesFileContent(newPages)

		expect(result)
			.toBe(`import { index, route, type RouteConfig } from '@react-router/dev/routes'

export default [
	index('routes/my-custom-page.tsx'),
	route('*', './catchall.tsx'),
] satisfies RouteConfig
`)
	})

	it('should handle pages with complex names and normalize them', () => {
		const newPages: Page[] = [
			{
				name: 'User Settings & Preferences',
				routePath: '/user-settings',
			},
			{
				name: 'API Documentation',
				routePath: '/api-docs',
			},
		]

		const result = getNewRoutesFileContent(newPages)

		expect(result)
			.toBe(`import { index, route, type RouteConfig } from '@react-router/dev/routes'

export default [
	route('/user-settings', 'routes/user-settings-&-preferences.tsx'),
	route('/api-docs', 'routes/api-documentation.tsx'),
	route('*', './catchall.tsx'),
] satisfies RouteConfig
`)
	})

	it('should handle routePath without leading slash', () => {
		const newPages: Page[] = [
			{
				name: 'Blog',
				routePath: 'blog',
			},
		]

		const result = getNewRoutesFileContent(newPages)

		expect(result)
			.toBe(`import { index, route, type RouteConfig } from '@react-router/dev/routes'

export default [
	route('/blog', 'routes/blog.tsx'),
	route('*', './catchall.tsx'),
] satisfies RouteConfig
`)
	})

	it('should handle mixed route configurations', () => {
		const newPages: Page[] = [
			{
				name: 'Home Page',
				routePath: '/',
			},
			{
				name: 'About Us',
				routePath: '/about',
			},
			{
				name: 'Services',
				routePath: 'services',
			},
			{
				name: 'Contact Form',
				routePath: '',
			},
		]

		const result = getNewRoutesFileContent(newPages)

		expect(result)
			.toBe(`import { index, route, type RouteConfig } from '@react-router/dev/routes'

export default [
	index('routes/home-page.tsx'),
	route('/about', 'routes/about-us.tsx'),
	route('/services', 'routes/services.tsx'),
	index('routes/contact-form.tsx'),
	route('*', './catchall.tsx'),
] satisfies RouteConfig
`)
	})
})
