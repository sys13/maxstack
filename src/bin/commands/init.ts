import { checkbox, input } from '@inquirer/prompts'
import { Command } from 'commander'
import { kebabCase } from 'es-toolkit'
import { copyFileSync, existsSync, mkdirSync, writeFileSync } from 'fs'
import { dirname, resolve } from 'path'
import { fileURLToPath } from 'url'
import { implStdFeatures } from '../../impl-std-features.js'

import { generateTypesContent } from './gen-config.js'
import {
	copyDirRecursive,
	createGitIgnore,
	generateConfigTemplate,
	updateFileWithReplacements,
} from './init.utils.js'

const __filename = fileURLToPath(import.meta.url)
const __dirname = dirname(__filename)

interface InitOptions {
	force?: boolean
	template?: string
}

export const initCommand = new Command('init')
	.description('Initialize a new MaxStack application')
	.option('-f, --force', 'overwrite existing files')
	// .option("-t, --template <type>", "configuration template to use", "default")
	.action(async (options: InitOptions) => {
		try {
			// Prompt for project details
			const projectName = await input({
				message: 'What is your project name?',
				validate: (input) => {
					if (!input.trim()) {
						return 'Project name is required'
					}
					return true
				},
			})

			const projectDescription = await input({
				default: '',
				message: 'What is your project description?',
			})

			// Prompt for standard features
			const selectedFeatures = await checkbox({
				choices: [
					{
						checked: false,
						name: 'Blog',
						value: 'blog',
					},
					{
						checked: false,
						name: 'SaaS Marketing',
						value: 'saas-marketing',
					},
				],
				message: 'Select the features you want to include:',
			})

			// Convert project name to kebab-case for directory name
			const dirName = kebabCase(projectName)
			const projectDir = resolve(process.cwd(), dirName)

			if (existsSync(projectDir) && !options.force) {
				console.error(
					`❌ Directory ${dirName} already exists. Use --force to overwrite.`,
				)
				return
			}

			if (!existsSync(projectDir)) {
				mkdirSync(projectDir, { recursive: true })
			}

			const templateDir = resolve(__dirname, '..', '..', '..', 'template')
			copyDirRecursive(templateDir, projectDir)

			const configPath = resolve(projectDir, 'maxstack.tsx')
			const maxstackDir = resolve(projectDir, '.maxstack')
			const typesPath = resolve(maxstackDir, 'types.ts')

			try {
				// Create .maxstack directory if it doesn't exist
				if (!existsSync(maxstackDir)) {
					mkdirSync(maxstackDir, { recursive: true })
				}

				// Create types.ts file if it doesn't exist
				if (!existsSync(typesPath)) {
					const typesContent = generateTypesContent()
					writeFileSync(typesPath, typesContent, 'utf8')
				}

				// Create maxstack.tsx configuration file with project details
				const configContent = generateConfigTemplate(
					options.template ?? 'default',
					projectName,
					projectDescription,
					selectedFeatures,
				)
				writeFileSync(configPath, configContent, 'utf8')

				// create .env.example file
				const envExamplePath = resolve(projectDir, '.env.example')
				const envPath = resolve(projectDir, '.env')
				copyFileSync(envExamplePath, envPath)

				// Update files that need the project name
				const replacements = { APP_NAME_KEBAB: dirName }
				updateFileWithReplacements(
					resolve(projectDir, 'fly.toml'),
					replacements,
				)
				updateFileWithReplacements(
					resolve(projectDir, 'deploy-fly.sh'),
					replacements,
				)
				updateFileWithReplacements(
					resolve(projectDir, 'cspell.json'),
					replacements,
				)

				await implStdFeatures({ projectDir, selectedFeatures })

				createGitIgnore(projectDir)

				// send messages to the user
				console.log(
					`🎉 Successfully created MaxStack project "${projectName}" in ${dirName}/`,
				)
				console.log('Next steps:')
				console.log(`cd ${dirName}\npnpm i\npnpm run dev`)
			} catch (error) {
				console.error(
					'❌ Failed to create configuration file:',
					(error as Error).message,
				)
			}
		} catch (err) {
			console.error('GLOBAL ERROR:', err)
		}
	})
