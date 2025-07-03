import { Command } from "commander";
import {
	copyFileSync,
	existsSync,
	mkdirSync,
	readdirSync,
	statSync,
	writeFileSync,
} from "fs";
import { dirname, resolve } from "path";
import { fileURLToPath } from "url";

import { generateTypesContent } from "./init.utils.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

interface InitOptions {
	force?: boolean;
	outdir: string;
	template?: string;
}

export const initCommand = new Command("init")
	.description("Initialize a new MaxStack application")
	.option("-f, --force", "overwrite existing files")
	.option(
		"-o, --outdir <path>",
		"output directory for the new application",
		"maxstack-app",
	)
	// .option("-t, --template <type>", "configuration template to use", "default")
	.action((options: InitOptions) => {
		try {
			const outdir = resolve(process.cwd(), options.outdir);

			if (existsSync(outdir) && !options.force) {
				console.error(
					`❌ Directory ${options.outdir} already exists. Use --force to overwrite.`,
				);
				return;
			}

			if (!existsSync(outdir)) {
				mkdirSync(outdir, { recursive: true });
			}

			const templateDir = resolve(__dirname, "..", "..", "..", "template");
			copyDirRecursive(templateDir, outdir);

			const configPath = resolve(outdir, "maxstack.tsx");
			try {
				writeFileSync(configPath, "test-write\n", { flag: "w" });
			} catch (e) {
				console.error("DEBUG: Failed to write test file to", configPath, e);
			}
			const maxstackDir = resolve(outdir, ".maxstack");
			const typesPath = resolve(maxstackDir, "types.ts");

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
		} catch (err) {
			console.error("GLOBAL ERROR:", err);
		}
	});

function copyDirRecursive(src: string, dest: string) {
	if (!existsSync(dest)) {
		mkdirSync(dest, { recursive: true });
	}
	for (const entry of readdirSync(src)) {
		const srcPath = resolve(src, entry);
		const destPath = resolve(dest, entry);
		if (statSync(srcPath).isDirectory()) {
			copyDirRecursive(srcPath, destPath);
		} else {
			copyFileSync(srcPath, destPath);
		}
	}
}

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
