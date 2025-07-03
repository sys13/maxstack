import { Command } from "commander";

import {
	collectProjectInfo,
	executeServerCommands,
	sendToServer,
} from "./gen.utils.js";

// Define type for gen command options
interface GenCommandOptions {
	dir?: string;
	production?: boolean;
}

// Ensure all errors are caught and handled for Commander async action
export const genCommand = new Command("gen")
	.description("Automate project updates by communicating with the maxserver")
	.option("--production", "Send real requests to the server")
	.option("--dir <path>", "Directory where files should be created")
	.action((opts: GenCommandOptions) => {
		return (async () => {
			try {
				// 1. Collect project info
				const projectInfo = await collectProjectInfo();

				// 2. Send to server (mocked or real)
				const commands = await sendToServer(projectInfo, opts.production);

				// 3. Execute received commands
				const mockMode = !opts.production;
				await executeServerCommands(commands, mockMode, opts.dir);

				console.log("gen: Completed successfully.");
				return; // Success, just return
			} catch (err) {
				if (err instanceof Error) {
					console.error("gen: Error:", err.stack ?? err.message);
				} else {
					console.error("gen: Error:", err);
				}
				throw err; // Let the error propagate for proper exit code
			}
		})();
	});
