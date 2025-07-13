import { input } from "@inquirer/prompts";
import { Command } from "commander";
import {
	copyFileSync,
	existsSync,
	mkdirSync,
	readdirSync,
	readFileSync,
	statSync,
	writeFileSync,
} from "fs";
import { dirname, resolve } from "path";
import { fileURLToPath } from "url";

import { generateTypesContent, toKebabCase } from "./init.utils.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

interface InitOptions {
	force?: boolean;
	template?: string;
}

/**
 * Updates a file by replacing placeholders with actual values.
 * @param filePath The path to the file to update
 * @param replacements Object containing placeholder-value pairs
 */
function updateFileWithReplacements(
	filePath: string,
	replacements: Record<string, string>,
): void {
	if (!existsSync(filePath)) {
		return;
	}

	try {
		let content = readFileSync(filePath, "utf8");

		for (const [placeholder, replacement] of Object.entries(replacements)) {
			content = content.replace(new RegExp(placeholder, "g"), replacement);
		}

		writeFileSync(filePath, content, "utf8");
	} catch (error) {
		console.error(`❌ Failed to update ${filePath}:`, (error as Error).message);
	}
}

export const initCommand = new Command("init")
	.description("Initialize a new MaxStack application")
	.option("-f, --force", "overwrite existing files")
	// .option("-t, --template <type>", "configuration template to use", "default")
	.action(async (options: InitOptions) => {
		try {
			// Prompt for project details
			const projectName = await input({
				message: "What is your project name?",
				validate: (input) => {
					if (!input.trim()) {
						return "Project name is required";
					}
					return true;
				},
			});

			const projectDescription = await input({
				default: "",
				message: "What is your project description?",
			});

			// Convert project name to kebab-case for directory name
			const dirName = toKebabCase(projectName);
			const outdir = resolve(process.cwd(), dirName);

			if (existsSync(outdir) && !options.force) {
				console.error(
					`❌ Directory ${dirName} already exists. Use --force to overwrite.`,
				);
				return;
			}

			if (!existsSync(outdir)) {
				mkdirSync(outdir, { recursive: true });
			}

			const templateDir = resolve(__dirname, "..", "..", "..", "template");
			copyDirRecursive(templateDir, outdir);

			const configPath = resolve(outdir, "maxstack.tsx");
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

				// Create maxstack.tsx configuration file with project details
				const configContent = generateConfigTemplate(
					options.template ?? "default",
					projectName,
					projectDescription,
				);
				writeFileSync(configPath, configContent, "utf8");
				console.log("✅ Created maxstack.tsx configuration file");

				console.log(
					`🎉 Successfully created MaxStack project "${projectName}" in ${dirName}/`,
				);
				const envExamplePath = resolve(outdir, ".env.example");
				const envPath = resolve(outdir, ".env");
				copyFileSync(envExamplePath, envPath);

				// Update fly.toml and deploy-fly.sh with project name
				const replacements = { APP_NAME_KEBAB: dirName };

				updateFileWithReplacements(resolve(outdir, "fly.toml"), replacements);
				updateFileWithReplacements(
					resolve(outdir, "deploy-fly.sh"),
					replacements,
				);
				updateFileWithReplacements(
					resolve(outdir, "cspell.json"),
					replacements,
				);
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

function generateConfigTemplate(
	templateType: string,
	projectName: string,
	projectDescription: string,
): string {
	const templates = {
		default: `import type { MAXConfig } from "./.maxstack/types";

export default {
	name: "${projectName}",
	description: "${projectDescription}",
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
