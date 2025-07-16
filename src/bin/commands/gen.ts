import { Command } from 'commander'

import { parseMaxstack } from '../../maxstack-parsing/parseMs.js'
import { parseRoutes } from '../../parseRoutes.js'

// Define type for gen command options
interface GenCommandOptions {
	dir?: string
	production?: boolean
}

// Ensure all errors are caught and handled for Commander async action
export const genCommand = new Command('gen')
	.description('Automate project updates by communicating with the maxserver')
	// eslint-disable-next-line @typescript-eslint/no-unused-vars
	.action((_opts: GenCommandOptions) => {
		return (async () => {
			const fs = await import('fs/promises')
			const path = await import('path')

			// we need to look at the maxstack config and generate the routes based on it
			const msConfig = await parseMaxstack(
				path.resolve(process.cwd(), 'maxstack-config.ts'),
			)
			const configRoutes = msConfig.pages

			const routesFilePath = path.resolve(process.cwd(), 'app', 'routes.ts')
			const routesFileContent = await fs.readFile(routesFilePath, 'utf-8')
			const routesInRoutesTsx = parseRoutes(routesFileContent)

			// Check if the routes in the config match the routes in routes.tsx
			const configRoutesPaths = configRoutes
				? configRoutes.map((route) => route.routePath)
				: []

			const routesInRoutesTsxPaths = routesInRoutesTsx.map(
				(route) => route.route,
			)

			const missingRoutes = configRoutesPaths.filter(
				(route) => !routesInRoutesTsxPaths.includes(route),
			)
			const extraRoutes = routesInRoutesTsxPaths.filter(
				(route) => !configRoutesPaths.includes(route),
			)

			// todo: modify the routes.tsx file to include the missing routes
			// the routes should use <Template componentName="" /> for any templateComponents

			// todo: create the components for the pages if they do not exist
		})()
	})
