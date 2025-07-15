import { Command } from 'commander'

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

			const routesFilePath = path.resolve(process.cwd(), 'app', 'routes.ts')
			let routesFileContent: string

			try {
				routesFileContent = await fs.readFile(routesFilePath, 'utf-8')
				console.log('routes.ts content:\n', routesFileContent)
			} catch (err) {
				console.error(`Failed to read routes.ts:`, err)
			}
		})()
	})
