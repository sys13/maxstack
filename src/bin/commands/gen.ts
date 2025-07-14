import { Command } from 'commander'

import {
	collectProjectInfo,
	executeCommands,
	generateCommands,
} from './gen.utils.js'

// Define type for gen command options
interface GenCommandOptions {
	dir?: string
}

// Ensure all errors are caught and handled for Commander async action
export const genCommand = new Command('gen')
	.description('Generate pages, components, and tests based on configuration')
	.option('--dir <path>', 'Directory where files should be created')
	.action((opts: GenCommandOptions) => {
		return (async () => {
			try {
				// 1. Collect project info
				const projectInfo = await collectProjectInfo()

				// 2. Generate commands based on configuration
				const commands = generateCommands(projectInfo)

				// 3. Execute commands
				await executeCommands(commands, opts.dir)

				console.log('gen: Completed successfully.')
				return // Success, just return
			} catch (err) {
				if (err instanceof Error) {
					console.error('gen: Error:', err.stack ?? err.message)
				} else {
					console.error('gen: Error:', err)
				}
				throw err // Let the error propagate for proper exit code
			}
		})()
	})
