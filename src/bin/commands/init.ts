import { Command } from "commander";
import { existsSync, mkdirSync, writeFileSync } from "fs";
import { resolve } from "path";

import { generateTypesContent } from "./init.utils.js";

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
		const maxstackDir = resolve(process.cwd(), ".maxstack");
		const typesPath = resolve(maxstackDir, "types.ts");

		// Check if file already exists
		if (existsSync(configPath) && !options.force) {
			console.error(
				"❌ maxstack.tsx already exists. Use --force to overwrite.",
			);
			return;
		}

		try {
			// Create .maxstack directory if it doesn't exist
			if (!existsSync(maxstackDir)) {
				mkdirSync(maxstackDir, { recursive: true });
				console.log("✅ Created .maxstack directory");
			}

			// Create types.ts file if it doesn't exist
			if (!existsSync(typesPath)) {
				const typesContent = generateTypesContent();
				writeFileSync(typesPath, typesContent, "utf8");
				console.log("✅ Created .maxstack/types.ts file");
			}

			// Create maxstack.tsx configuration file
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
		default: `import type { MAXConfig } from "./.maxstack/types";

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
