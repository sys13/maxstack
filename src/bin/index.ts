import { Command } from "commander";

import { initCommand } from "./commands/init.js";

export function bin(): void {
	const program = new Command();

	program
		.name("maxstack")
		.description("A powerful development stack management tool")
		.version("0.1.0");

	// Add the init command
	program.addCommand(initCommand);

	program.parse();
}
