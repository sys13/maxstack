import {
	copyFileSync,
	existsSync,
	mkdirSync,
	readdirSync,
	readFileSync,
	statSync,
	writeFileSync,
} from 'fs'
import { resolve } from 'path'

export function copyDirRecursive(src: string, dest: string) {
	if (!existsSync(dest)) {
		mkdirSync(dest, { recursive: true })
	}
	for (const entry of readdirSync(src)) {
		const srcPath = resolve(src, entry)
		const destPath = resolve(dest, entry)
		if (statSync(srcPath).isDirectory()) {
			copyDirRecursive(srcPath, destPath)
		} else {
			copyFileSync(srcPath, destPath)
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
			: '[]'

	const templates = {
		default: `import type { MAXConfig } from "./.maxstack/types";

export default {
	name: "${projectName}",
	description: "${projectDescription}",
	standardFeatures: ${featuresArray},
	pages: [],
} as const satisfies MAXConfig;
`,
	}

	return templates[templateType as keyof typeof templates] || templates.default
}

export function updateFileWithReplacements(
	filePath: string,
	replacements: Record<string, string>,
): void {
	if (!existsSync(filePath)) {
		return
	}

	try {
		let content = readFileSync(filePath, 'utf8')

		for (const [placeholder, replacement] of Object.entries(replacements)) {
			content = content.replace(new RegExp(placeholder, 'g'), replacement)
		}

		writeFileSync(filePath, content, 'utf8')
	} catch (error) {
		console.error(`❌ Failed to update ${filePath}:`, (error as Error).message)
	}
}

export function createGitIgnore(projectDir: string) {
	const gitIgnorePath = resolve(projectDir, '.gitignore')
	if (!existsSync(gitIgnorePath)) {
		const gitIgnoreContent = `.DS_Store
/node_modules/
/.env

# React Router
/.react-router/
/build/

local.db
test-seed.db

/coverage/

# Playwright
node_modules/
/test-results/
/playwright-report/
/blob-report/
/playwright/.cache/
`
		writeFileSync(gitIgnorePath, gitIgnoreContent, 'utf8')
		console.log('Created .gitignore file')
	}
}
