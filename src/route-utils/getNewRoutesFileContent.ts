import { Page } from '../maxstack-parsing/msZod.js'

/**
 * Generate React Router routes file content from Page objects.
 */
export function getNewRoutesFileContent(newPages: Page[]): string {
	if (newPages.length === 0) {
		return `import { index, route, type RouteConfig } from '@react-router/dev/routes'

export default [
	index('routes/home.tsx'),
	route('/healthcheck', 'routes/healthcheck.tsx'),
	route('*', './catchall.tsx'),
] satisfies RouteConfig
`
	}

	const routes: string[] = []

	// Process each page to generate route entries
	for (const page of newPages) {
		const fileName = `routes/${page.name.toLowerCase().replace(/\s+/g, '-')}.tsx`

		if (page.routePath === '/' || page.routePath === '') {
			// Use index route for the root path
			routes.push(`\tindex('${fileName}')`)
		} else {
			// Use regular route for other paths
			const normalizedPath = page.routePath.startsWith('/')
				? page.routePath
				: `/${page.routePath}`
			routes.push(`\troute('${normalizedPath}', '${fileName}')`)
		}
	}

	// Always add the standard routes at the end
	routes.push(`\troute('/healthcheck', 'routes/healthcheck.tsx'),`)
	routes.push(`\troute('*', './catchall.tsx')`)

	return `import { index, route, type RouteConfig } from '@react-router/dev/routes'

export default [
${routes.join(',\n')},
] satisfies RouteConfig
`
}
