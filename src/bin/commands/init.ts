import { Command } from "commander";
import { existsSync, writeFileSync } from "fs";
import { resolve } from "path";

interface InitOptions {
	force?: boolean;
	template?: string;
}

export const initCommand = new Command("init")
	.description("Initialize a new MaxStack configuration file")
	.option("-f, --force", "overwrite existing maxstack.tsx file")
	// .option("-t, --template <type>", "configuration template to use", "default")
	.action((options: InitOptions) => {
		const configPath = resolve(process.cwd(), "maxstack.tsx");

		// Check if file already exists
		if (existsSync(configPath) && !options.force) {
			console.error(
				"❌ maxstack.tsx already exists. Use --force to overwrite.",
			);
			return;
		}

		try {
			const configContent = generateConfigTemplate(
				options.template ?? "default",
			);
			writeFileSync(configPath, configContent, "utf8");
			console.log("✅ Created maxstack.tsx configuration file");
		} catch (error) {
			console.error(
				"❌ Failed to create configuration file:",
				(error as Error).message,
			);
		}
	});

function generateConfigTemplate(templateType: string): string {
	const templates = {
		default: `import type { MAXConfig } from "./types/types";

export default {
	name: "",
	description: "",
	standardFeatures: [],
	personas: [],
	features: [],
	pages: [],
	models: [],
	unitTests: [],
	e2eTests: [],
} as const satisfies MAXConfig;
`,
	};

	return templates[templateType as keyof typeof templates] || templates.default;
}
