interface ParsedRoute {
	filePath: string
	layout?: string
	route: string
}

// https://reactrouter.com/api/framework-conventions/routes.ts
// route should be parsed as a route with the given path
// index should be parsed as if it were a route with /
// layout should be noted as a component that wraps other routes
// prefix should prefix all routes in a specific path
// `import { index, route, type RouteConfig, } from '@react-router/dev/routes'

// export default [
// 	index('routes/home.tsx'),
// 	route('*', './catchall.tsx'),
// 	route('/api/auth/*', 'routes/auth-handler.ts'),
// 	route('/healthcheck', 'routes/healthcheck.tsx'),
// 	route('/login', 'routes/login.tsx'),
// 	route('/signup', 'routes/signup.tsx'),
// 	route('/verify-email', 'routes/verify-email.tsx'),
// 	route('/forgot-password', 'routes/forgot-password.tsx'),
// 	route('/reset-password', 'routes/reset-password.tsx'),
// ] satisfies RouteConfig
// `
export function parseRoutes(routesFileContent: string): ParsedRoute[] {
	const routeRegex = /route\(\s*['"]([^'"]+)['"]\s*,\s*['"]([^'"]+)['"]\s*\)/g
	const indexRegex = /index\(\s*['"]([^'"]+)['"]\s*\)/g
	const layoutRegex = /layout:\s*['"]([^'"]+)['"]/g

	const routes: ParsedRoute[] = []

	// Find all matches with their positions to preserve order
	const allMatches: {
		match: RegExpExecArray
		type: 'index' | 'layout' | 'route'
	}[] = []

	let match: null | RegExpExecArray

	// Reset regex lastIndex to ensure we start from the beginning
	routeRegex.lastIndex = 0
	indexRegex.lastIndex = 0
	layoutRegex.lastIndex = 0

	while ((match = routeRegex.exec(routesFileContent)) !== null) {
		allMatches.push({ match, type: 'route' })
	}

	routeRegex.lastIndex = 0
	while ((match = indexRegex.exec(routesFileContent)) !== null) {
		allMatches.push({ match, type: 'index' })
	}

	indexRegex.lastIndex = 0
	while ((match = layoutRegex.exec(routesFileContent)) !== null) {
		allMatches.push({ match, type: 'layout' })
	}

	// Sort by position in the file
	allMatches.sort((a, b) => a.match.index - b.match.index)

	// Process matches in order
	for (const { match, type } of allMatches) {
		if (type === 'route') {
			routes.push({
				filePath: match[2],
				route: match[1],
			})
		} else if (type === 'index') {
			routes.push({
				filePath: match[1],
				route: '/',
			})
		} else {
			// type === 'layout'
			const lastRoute = routes.at(-1)
			if (lastRoute) {
				lastRoute.layout = match[1]
			}
		}
	}

	return routes
}
