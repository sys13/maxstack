import { Command } from 'commander'

import { parseMaxstack } from '../../maxstack-parsing/parseMs.js'

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
		})()
	})
