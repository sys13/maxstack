import { checkbox, input } from "@inquirer/prompts";
import { Command } from "commander";
import { copyFileSync, existsSync, mkdirSync, writeFileSync } from "fs";
import { dirname, resolve } from "path";
import { fileURLToPath } from "url";

import { generateTypesContent } from "./gen-config.js";
import {
	copyDirRecursive,
	generateConfigTemplate,
	removeAuthenticationFiles,
	toKebabCase,
	updateFileWithReplacements,
} from "./init.utils.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

interface InitOptions {
	force?: boolean;
	template?: string;
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

			// Prompt for standard features
			const selectedFeatures = await checkbox({
				choices: [
					{
						checked: false,
						name: "User Authentication",
						value: "user-authentication",
					},
					{
						checked: false,
						name: "Blog",
						value: "blog",
					},
					{
						checked: false,
						name: "SaaS Marketing",
						value: "saas-marketing",
					},
				],
				message: "Select the features you want to include:",
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

			// Remove authentication files if User Authentication feature is not selected
			if (!selectedFeatures.includes("user-authentication")) {
				removeAuthenticationFiles(outdir);
			}

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
					selectedFeatures,
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
