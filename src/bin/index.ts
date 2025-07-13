// eslint-disable-next-line @eslint-community/eslint-comments/disable-enable-pair
/* eslint-disable n/no-process-exit */
import { Command } from "commander";

import { genCommand } from "./commands/gen.js";
import { initCommand } from "./commands/init.js";

export function bin(): void {
	const program = new Command();

	program
		.name("maxstack")
		.description("A powerful development stack management tool")
		.version("0.1.0");

	// Add the init command
	program.addCommand(initCommand);
	program.addCommand(genCommand);

	program.exitOverride(); // Prevent Commander from exiting the process

	// If no arguments provided, show help and exit 0
	if (process.argv.length <= 2) {
		program.outputHelp();
		process.exit(0);
	}

	try {
		program.parse();
		// eslint-disable-next-line @typescript-eslint/no-explicit-any
	} catch (err: any) {
		// eslint-disable-next-line @typescript-eslint/no-unsafe-member-access
		if (err && typeof err.exitCode === "number" && err.exitCode === 0) {
			// Help/version output, exit 0
			process.exit(0);
		}
		// Other errors: log and exit 1
		// eslint-disable-next-line @typescript-eslint/no-unsafe-member-access
		console.error(err.message ?? err);
		process.exit(1);
	}
}

// Register CLI entry for ESM (no require.main)
if (process.argv[1] && import.meta.url === `file://${process.argv[1]}`) {
	// Top-level error handlers for debugging test failures
	process.on("unhandledRejection", (reason) => {
		console.error("[unhandledRejection]", reason);
		process.exit(1);
	});
	process.on("uncaughtException", (err) => {
		console.error("[uncaughtException]", err);
		process.exit(1);
	});
	bin();
}
