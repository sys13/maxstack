import {
	copyFileSync,
	existsSync,
	mkdirSync,
	readdirSync,
	readFileSync,
	statSync,
	unlinkSync,
	writeFileSync,
} from "fs";
import { resolve } from "path";

export function copyDirRecursive(src: string, dest: string) {
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

export function generateConfigTemplate(
	templateType: string,
	projectName: string,
	projectDescription: string,
	selectedFeatures?: string[],
): string {
	const featuresArray =
		selectedFeatures && selectedFeatures.length > 0
			? `["${selectedFeatures.join('", "')}"]`
			: "[]";

	const templates = {
		default: `import type { MAXConfig } from "./.maxstack/types";

export default {
	name: "${projectName}",
	description: "${projectDescription}",
	standardFeatures: ${featuresArray},
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

export function removeAuthenticationFiles(projectDir: string): void {
	const authFiles = [
		"app/routes/auth-handler.ts",
		"app/lib/auth-client.ts",
		"app/lib/auth.server.ts",
	];

	// Remove authentication files
	for (const file of authFiles) {
		const filePath = resolve(projectDir, file);
		if (existsSync(filePath)) {
			try {
				unlinkSync(filePath);
				console.log(`✅ Removed ${file}`);
			} catch (error) {
				console.error(`❌ Failed to remove ${file}:`, (error as Error).message);
			}
		}
	}

	// Remove auth route from routes.ts
	const routesPath = resolve(projectDir, "app/routes.ts");
	if (existsSync(routesPath)) {
		try {
			let content = readFileSync(routesPath, "utf8");

			// Remove the auth route line
			content = content.replace(
				/^\s*route\("\/api\/auth\/\*",\s*"routes\/auth-handler\.ts"\),?\s*\n/gm,
				"",
			);

			writeFileSync(routesPath, content, "utf8");
		} catch (error) {
			console.error(`❌ Failed to update routes.ts:`, (error as Error).message);
		}
	}
}

export function toKebabCase(str: string): string {
	return str
		.trim()
		.toLowerCase()
		.replace(/[_\s]+/g, "-") // Convert underscores and spaces to hyphens
		.replace(/[^a-z0-9-]/g, "") // Remove special characters except hyphens
		.replace(/-+/g, "-") // Replace multiple hyphens with single hyphen
		.replace(/^-|-$/g, ""); // Remove leading/trailing hyphens
}

export function updateFileWithReplacements(
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
