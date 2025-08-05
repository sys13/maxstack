import { Page } from '../maxstack-parsing/msZod.js'

/**
 * Generate React Router routes file content from Page objects.
 */

export function getNewRoutesFileContent(newPages: Page[]): string {
	// Helper to normalize file names from page names
	function normalizeFileName(name: string): string {
		return name
			.toLowerCase()
			.replace(/\s+/g, '-')
			.replace(/[^a-z0-9\-&]/g, '-')
			.replace(/-+/g, '-')
			.replace(/^-|-$/g, '')
	}

	// Helper to normalize route paths
	function normalizeRoutePath(routePath: string | undefined): string {
		if (!routePath || routePath.trim() === '') {
			// If no routePath, generate from name
			return ''
		}
		let p = routePath.trim()
		if (!p.startsWith('/')) {
			p = '/' + p
		}
		return p
	}

	const routes: string[] = []

	if (newPages.length === 0) {
		routes.push(`\tindex('routes/home.tsx')`)
	} else {
		for (const page of newPages) {
			const fileName = `routes/${normalizeFileName(page.name)}.tsx`
			const routePath = normalizeRoutePath(page.routePath)

			if (routePath === '/' || routePath === '') {
				// index route for root or empty
				routes.push(`\tindex('${fileName}')`)
			} else {
				routes.push(`\troute('${routePath}', '${fileName}')`)
			}
		}
	}

	// Always add catchall and healthcheck at the end
	routes.push(`\troute('/healthcheck', 'routes/healthcheck.tsx')`)
	routes.push(`\troute('*', './catchall.tsx')`)

	return `import { index, route, type RouteConfig } from '@react-router/dev/routes'

export default [
${routes.join(',\n')}
] satisfies RouteConfig
`
}
