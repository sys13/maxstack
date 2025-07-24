import { Command } from 'commander'

import { parseMaxstack } from '../../maxstack-parsing/parseMs.js'
import { createRouteText } from '../../route-utils/createRoute.js'
import { getNewRoutesFileContent } from '../../route-utils/getNewRoutesFileContent.js'
import { parseRoutes } from '../../route-utils/parseRoutes.js'
import { readIfExists } from './gen.utils.js'

// Define type for gen command options
interface GenCommandOptions {
	dir?: string
	production?: boolean
}

// Ensure all errors are caught and handled for Commander async action
export const genCommand = new Command('gen')
	.description('Automate project updates by communicating with the maxserver')
	// eslint-disable-next-line @typescript-eslint/no-unused-vars
	.action(async (_opts: GenCommandOptions) => {
		await gen()
	})

function invariant(condition: boolean, message: string): asserts condition {
	if (!condition) {
		throw new Error(message)
	}
}

export async function gen(projectDir?: string) {
	const fs = await import('fs/promises')
	const path = await import('path')

	const workingDir = projectDir ?? process.cwd()

	// we need to look at the maxstack config and generate the routes based on it
	const msConfig = await parseMaxstack(path.resolve(workingDir, 'maxstack.tsx'))
	const configRoutes = msConfig.pages

	const routesFilePath = path.resolve(workingDir, 'app', 'routes.ts')
	const routesFileContent = await readIfExists(routesFilePath)
	invariant(
		routesFileContent !== null,
		`Routes file not found at ${routesFilePath}. Please ensure it exists.`,
	)
	const routesInRoutesTsx = parseRoutes(routesFileContent)

	const routesInRoutesTsxPaths = routesInRoutesTsx.map((route) => route.route)

	const pagesToCreate = configRoutes?.filter(
		(page) => !routesInRoutesTsxPaths.includes(page.routePath),
	)

	if (pagesToCreate === undefined || pagesToCreate.length === 0) {
		console.log('All routes are already defined in routes.tsx')
		return
	}

	console.log(
		`The following routes are missing in routes.tsx: ${pagesToCreate
			.map(({ name }) => name)
			.join(', ')}`,
	)

	for (const page of pagesToCreate) {
		const result = createRouteText(page)
		const routeFilePath = path.resolve(
			workingDir,
			'app',
			'routes',
			result.fileName,
		)
		await fs.writeFile(routeFilePath, result.fileString, 'utf-8')
		console.log(`Created route file: ${result.fileName}`)
	}

	const routesText = getNewRoutesFileContent(pagesToCreate)
	await fs.writeFile(routesFilePath, routesText, 'utf-8')
}
