import fs from 'fs/promises'
import path from 'path'

// Types
export interface ExecuteCommandsResult {
	created: string[]
	edited: string[]
	errors: { error: unknown; file: string }[]
	updated: string[]
}

export interface ProjectInfo {
	config: null | string
	dir: Record<string, unknown>
	maxstackConfig?: MAXConfig | null
	pkg: null | string
	routes: null | string
}

// Import MAXConfig from the template types
export interface MAXConfig {
	description: string
	name: string
	standardFeatures?: string[]
	pages?: Page[]
}

export interface Page {
	name: string
	description?: string
	routePath?: string
	components?: string[]
	infoOnPage?: string[]
	userActions?: string[]
	authRequired?: boolean
}

export interface GenerateCommand {
	content?: string
	file: string
	type: 'create' | 'edit' | 'update'
}

// Generate page commands from configuration
function generatePageCommands(
	pages: Page[],
	appName: string,
): GenerateCommand[] {
	const commands: GenerateCommand[] = []

	for (const page of pages) {
		const routeName = page.name.toLowerCase().replace(/\s+/g, '-')
		const componentName = page.name.replace(/\s+/g, '')
		const routePath = page.routePath || `/${routeName}`

		const pageContent = `import type { Route } from './+types/${routeName}'

export function meta({}: Route.MetaArgs) {
	return [
		{ title: \`${appName} - ${page.name}\` },
		{ name: 'description', content: '${page.description || `${page.name} page`}' },
	]
}

export default function ${componentName}({}: Route.ComponentProps) {
	return (
		<div className="container mx-auto px-4 py-8">
			<h1 className="text-3xl font-bold mb-6">${page.name}</h1>
			${page.description ? `<p className="text-lg text-gray-600 mb-8">${page.description}</p>` : ''}
			
			${
				page.infoOnPage && page.infoOnPage.length > 0
					? `
			<div className="mb-8">
				<h2 className="text-xl font-semibold mb-4">Information</h2>
				<ul className="list-disc list-inside space-y-2">
					${page.infoOnPage.map((info) => `<li>${info}</li>`).join('\n\t\t\t\t\t')}
				</ul>
			</div>`
					: ''
			}
			
			${
				page.userActions && page.userActions.length > 0
					? `
			<div className="space-x-4">
				${page.userActions.map((action) => `<button className="bg-blue-500 hover:bg-blue-700 text-white font-bold py-2 px-4 rounded">${action}</button>`).join('\n\t\t\t\t')}
			</div>`
					: ''
			}
		</div>
	)
}
`

		commands.push({
			content: pageContent,
			file: `app/routes/${routeName}.tsx`,
			type: 'create',
		})
	}

	return commands
}

// Generate routes.ts update
function generateRoutesUpdate(pages: Page[]): GenerateCommand[] {
	const commands: GenerateCommand[] = []

	const routeEntries = pages
		.map((page) => {
			const routeName = page.name.toLowerCase().replace(/\s+/g, '-')
			const routePath = page.routePath || `/${routeName}`
			return `\troute('${routePath}', 'routes/${routeName}.tsx'),`
		})
		.join('\n')

	const routesUpdateContent = `// Add these routes to your routes.ts file:
${routeEntries}

// Example routes.ts structure:
import { type RouteConfig, route, index, layout, prefix } from "@react-router/dev/routes";

export default [
	index("routes/home.tsx"),
${routeEntries}
] satisfies RouteConfig;
`

	commands.push({
		content: routesUpdateContent,
		file: 'routes-update.txt',
		type: 'create',
	})

	return commands
}

// Collects config, routes, package.json, and directory structure (excluding node_modules)
export async function collectProjectInfo(): Promise<ProjectInfo> {
	const root = process.cwd()
	const [config, routes, pkg, dir, maxstackConfig] = await Promise.all([
		readIfExists(path.join(root, 'tsdown.config.ts')),
		readIfExists(path.join(root, 'template', 'react-router.config.ts')),
		readIfExists(path.join(root, 'package.json')),
		getDirectoryStructure(root, ['node_modules', '.git']),
		loadMaxstackConfig(),
	])
	return { config, dir, maxstackConfig, pkg, routes }
}

async function readIfExists(filePath: string): Promise<null | string> {
	try {
		const data = await fs.readFile(filePath, 'utf8')
		return data
	} catch {
		return null
	}
}

// Recursively get directory structure, excluding specified folders
async function getDirectoryStructure(
	dir: string,
	exclude: string[] = [],
): Promise<Record<string, unknown>> {
	const entries = await fs.readdir(dir, { withFileTypes: true })
	const structure: Record<string, unknown> = {}
	for (const entry of entries) {
		if (exclude.includes(entry.name)) {
			continue
		}
		const fullPath = path.join(dir, entry.name)
		if (entry.isDirectory()) {
			structure[entry.name] = await getDirectoryStructure(fullPath, exclude)
		} else {
			structure[entry.name] = 'file'
		}
	}
	return structure
}

// Load and parse maxstack.tsx config
async function loadMaxstackConfig(): Promise<MAXConfig | null> {
	try {
		const configPath = path.join(process.cwd(), 'maxstack.tsx')
		const configContent = await fs.readFile(configPath, 'utf-8')

		// Extract the default export object
		const configRegex = /export default\s+\{[\s\S]*?\}\s+as const/
		const configMatch = configRegex.exec(configContent)
		if (!configMatch) {
			console.error('[loadMaxstackConfig] Could not parse maxstack.tsx config')
			return null
		}

		// Parse basic config
		const nameRegex = /name:\s*["']([^"']*?)["']/
		const nameMatch = nameRegex.exec(configContent)
		const descRegex = /description:\s*["']([^"']*?)["']/
		const descMatch = descRegex.exec(configContent)

		// Parse standardFeatures array
		const standardFeaturesRegex = /standardFeatures:\s*\[([\s\S]*?)\]/
		const standardFeaturesMatch = standardFeaturesRegex.exec(configContent)
		let standardFeatures: string[] = []
		if (standardFeaturesMatch) {
			const featuresContent = standardFeaturesMatch[1]
			const featureMatches = featuresContent.match(/["']([^"']+)["']/g)
			if (featureMatches) {
				standardFeatures = featureMatches.map((match) =>
					match.replace(/["']/g, ''),
				)
			}
		}

		// Parse pages array - need to find the complete pages array by matching balanced brackets
		const pagesStartMatch = /pages:\s*\[/.exec(configContent)
		let pages: Page[] = []
		if (pagesStartMatch) {
			try {
				// Find the complete pages array by matching balanced brackets
				const startIndex = pagesStartMatch.index + pagesStartMatch[0].length - 1 // Position of opening '['
				let bracketCount = 0
				let pagesEndIndex = -1

				for (let i = startIndex; i < configContent.length; i++) {
					const char = configContent[i]
					if (char === '[') {
						bracketCount++
					} else if (char === ']') {
						bracketCount--
						if (bracketCount === 0) {
							pagesEndIndex = i
							break
						}
					}
				}

				if (pagesEndIndex > startIndex) {
					const pagesContent = configContent
						.substring(startIndex + 1, pagesEndIndex)
						.trim()

					// Find page objects by matching balanced braces
					const pageObjects: string[] = []
					let braceCount = 0
					let currentPageStart = -1

					for (let i = 0; i < pagesContent.length; i++) {
						const char = pagesContent[i]
						if (char === '{') {
							if (braceCount === 0) {
								currentPageStart = i
							}
							braceCount++
						} else if (char === '}') {
							braceCount--
							if (braceCount === 0 && currentPageStart !== -1) {
								const pageObject = pagesContent.substring(
									currentPageStart,
									i + 1,
								)
								pageObjects.push(pageObject)
								currentPageStart = -1
							}
						}
					}

					if (pageObjects.length > 0) {
						pages = pageObjects.map((pageStr) => {
							const page: Page = { name: '' }

							const nameMatch = /name:\s*["']([^"']*?)["']/.exec(pageStr)
							if (nameMatch) {
								page.name = nameMatch[1]
							}

							const descMatch = /description:\s*["']([^"']*?)["']/.exec(pageStr)
							if (descMatch) {
								page.description = descMatch[1]
							}

							const routeMatch = /routePath:\s*["']([^"']*?)["']/.exec(pageStr)
							if (routeMatch) {
								page.routePath = routeMatch[1]
							}

							const authMatch = /authRequired:\s*(true|false)/.exec(pageStr)
							if (authMatch) {
								page.authRequired = authMatch[1] === 'true'
							}

							// Parse components array
							const componentsMatch = /components:\s*\[([\s\S]*?)\]/.exec(
								pageStr,
							)
							if (componentsMatch) {
								const compMatches =
									componentsMatch[1].match(/["']([^"']+)["']/g)
								if (compMatches) {
									page.components = compMatches.map((match) =>
										match.replace(/["']/g, ''),
									)
								}
							}

							// Parse infoOnPage array
							const infoMatch = /infoOnPage:\s*\[([\s\S]*?)\]/.exec(pageStr)
							if (infoMatch) {
								const infoMatches = infoMatch[1].match(/["']([^"']+)["']/g)
								if (infoMatches) {
									page.infoOnPage = infoMatches.map((match) =>
										match.replace(/["']/g, ''),
									)
								}
							}

							// Parse userActions array
							const actionsMatch = /userActions:\s*\[([\s\S]*?)\]/.exec(pageStr)
							if (actionsMatch) {
								const actionMatches = actionsMatch[1].match(/["']([^"']+)["']/g)
								if (actionMatches) {
									page.userActions = actionMatches.map((match) =>
										match.replace(/["']/g, ''),
									)
								}
							}

							return page
						})
					}
				}
			} catch (error) {
				console.error('[loadMaxstackConfig] Error parsing pages:', error)
			}
		}

		const config = {
			description: descMatch?.[1] ?? 'A MAXSTACK application',
			name: nameMatch?.[1] ?? 'MAXSTACK App',
			standardFeatures,
			pages,
		} as MAXConfig

		return config
	} catch (error) {
		console.error('[loadMaxstackConfig] Error loading config:', error)
		return null
	}
}

// Generate commands based on project configuration
export function generateCommands(projectInfo: ProjectInfo): GenerateCommand[] {
	const commands: GenerateCommand[] = []

	// Generate pages from configuration
	if (projectInfo.maxstackConfig?.pages) {
		console.log('✅ Found pages in configuration. Generating page files...')
		const pageCommands = generatePageCommands(
			projectInfo.maxstackConfig.pages,
			projectInfo.maxstackConfig.name,
		)
		commands.push(...pageCommands)
	}

	// Check if we should generate standard feature content
	if (
		projectInfo.maxstackConfig?.standardFeatures?.includes('saas-marketing')
	) {
		console.log(
			'✅ Found saas-marketing in standardFeatures. Generating marketing models...',
		)
		commands.push(...generateMarketingModels())
	}

	if (projectInfo.maxstackConfig?.standardFeatures?.includes('blog')) {
		console.log('✅ Found blog in standardFeatures. Generating blog models...')
		commands.push(...generateBlogModels())
	}

	// Generate basic database schema commands if no models exist
	commands.push(...generateBasicDatabaseSchemaCommands())

	// Generate routes.ts update
	if (projectInfo.maxstackConfig?.pages) {
		commands.push(...generateRoutesUpdate(projectInfo.maxstackConfig.pages))
	}

	return commands
}

// Generate marketing models
function generateMarketingModels(): GenerateCommand[] {
	const commands: GenerateCommand[] = []

	// User preferences model for marketing
	const userPreferencesModel = `import { sql } from 'drizzle-orm'
import { sqliteTable, text, integer, index } from 'drizzle-orm/sqlite-core'

// Common fields
const id = text('id').primaryKey().notNull()
const timestamps = {
	createdAt: integer('created_at', { mode: 'timestamp' }).default(sql\`(unixepoch())\`).notNull(),
	updatedAt: integer('updated_at', { mode: 'timestamp' }).default(sql\`(unixepoch())\`).notNull(),
}

export const userPreferences = sqliteTable(
	'user_preferences',
	{
		id,
		userId: text('user_id')
			.notNull()
			.unique()
			.references(() => user.id, { onDelete: 'cascade' }),
		// Email notification preferences
		newsletter: integer('newsletter', { mode: 'boolean' }).notNull().default(true),
		productUpdates: integer('product_updates', { mode: 'boolean' }).notNull().default(true),
		taskReminders: integer('task_reminders', { mode: 'boolean' }).notNull().default(true),
		accountNotifications: integer('account_notifications', { mode: 'boolean' }).notNull().default(true),
		marketingEmails: integer('marketing_emails', { mode: 'boolean' }).notNull().default(false),
		...timestamps,
	},
	(t) => [index('user_preferences_user_idx').on(t.userId)],
)

// Note: This assumes you have a user table imported. 
// You may need to adjust the import based on your user model location.
// import { user } from './user'
`

	commands.push({
		content: userPreferencesModel,
		file: 'app/db/schema/marketing.ts',
		type: 'create',
	})

	return commands
}

// Generate blog models
function generateBlogModels(): GenerateCommand[] {
	const commands: GenerateCommand[] = []

	const blogModels = `import { sql } from 'drizzle-orm'
import { sqliteTable, text, integer, index } from 'drizzle-orm/sqlite-core'

// Common fields
const id = text('id').primaryKey().notNull()
const timestamps = {
	createdAt: integer('created_at', { mode: 'timestamp' }).default(sql\`(unixepoch())\`).notNull(),
	updatedAt: integer('updated_at', { mode: 'timestamp' }).default(sql\`(unixepoch())\`).notNull(),
}

// Blog-related tables
export const blogPost = sqliteTable(
	'blog_post',
	{
		id,
		title: text('title').notNull(),
		slug: text('slug').notNull().unique(),
		summary: text('summary'),
		content: text('content'),
		status: text('status').notNull().default('draft'), // draft, published, archived
		publishedAt: integer('published_at', { mode: 'timestamp' }),
		authorId: text('author_id')
			.notNull()
			.references(() => user.id, { onDelete: 'cascade' }),
		readingMinutes: integer('reading_minutes'),
		coverImage: text('cover_image'),
		...timestamps,
	},
	(t) => [
		index('blog_post_author_idx').on(t.authorId),
		index('blog_post_status_idx').on(t.status),
		index('blog_post_slug_idx').on(t.slug),
		index('blog_post_published_idx').on(t.publishedAt),
	],
)

export const blogCategory = sqliteTable(
	'blog_category',
	{
		id,
		name: text('name').notNull().unique(),
		description: text('description'),
		slug: text('slug').notNull().unique(),
		color: text('color'),
		...timestamps,
	},
	(t) => [
		index('blog_category_name_idx').on(t.name),
		index('blog_category_slug_idx').on(t.slug),
	],
)

export const blogTag = sqliteTable(
	'blog_tag',
	{
		id,
		name: text('name').notNull().unique(),
		slug: text('slug').notNull().unique(),
		...timestamps,
	},
	(t) => [
		index('blog_tag_name_idx').on(t.name),
		index('blog_tag_slug_idx').on(t.slug),
	],
)

export const blogPostCategory = sqliteTable(
	'blog_post_category',
	{
		postId: text('post_id')
			.notNull()
			.references(() => blogPost.id, { onDelete: 'cascade' }),
		categoryId: text('category_id')
			.notNull()
			.references(() => blogCategory.id, { onDelete: 'cascade' }),
	},
	(t) => [
		index('blog_post_category_post_idx').on(t.postId),
		index('blog_post_category_category_idx').on(t.categoryId),
	],
)

export const blogPostTag = sqliteTable(
	'blog_post_tag',
	{
		postId: text('post_id')
			.notNull()
			.references(() => blogPost.id, { onDelete: 'cascade' }),
		tagId: text('tag_id')
			.notNull()
			.references(() => blogTag.id, { onDelete: 'cascade' }),
	},
	(t) => [
		index('blog_post_tag_post_idx').on(t.postId),
		index('blog_post_tag_tag_idx').on(t.tagId),
	],
)

// Note: This assumes you have a user table imported. 
// You may need to adjust the import based on your user model location.
// import { user } from './user'
`

	commands.push({
		content: blogModels,
		file: 'app/db/schema/blog.ts',
		type: 'create',
	})

	return commands
}

// Executes commands
export async function executeCommands(
	commands: GenerateCommand[],
	outputDir?: string,
): Promise<ExecuteCommandsResult> {
	const workingDir = outputDir ?? process.cwd()
	const updated: string[] = []
	const created: string[] = []
	const edited: string[] = []
	const errors: { error: unknown; file: string }[] = []

	for (const cmd of commands) {
		try {
			// Use working directory (either temp or current) for all file operations
			const filePath = path.join(workingDir, cmd.file)

			// Ensure the directory exists before creating the file
			const fileDir = path.dirname(filePath)
			await fs.mkdir(fileDir, { recursive: true })

			switch (cmd.type) {
				case 'create':
					await fs.writeFile(filePath, cmd.content ?? '', 'utf8')
					created.push(cmd.file)
					console.log(`Created ${cmd.file} in ${workingDir}`)
					break
				case 'edit':
					await fs.writeFile(filePath, cmd.content ?? '', 'utf8')
					edited.push(cmd.file)
					console.log(`Edited ${cmd.file} in ${workingDir}`)
					break
				case 'update':
					await fs.writeFile(filePath, cmd.content ?? '', 'utf8')
					updated.push(cmd.file)
					console.log(`Updated ${cmd.file} in ${workingDir}`)
					break
				default:
					console.warn('Unknown command:', cmd)
					break
			}
		} catch (error) {
			errors.push({ error, file: cmd.file })
			console.error(`Error processing ${cmd.file}:`, error)
		}
	}
	return { created, edited, errors, updated }
}

// Generate basic database schema commands
function generateBasicDatabaseSchemaCommands(): GenerateCommand[] {
	const commands: GenerateCommand[] = []

	// Basic user schema
	const userSchema = `import { sql } from 'drizzle-orm'
import { sqliteTable, text, integer } from 'drizzle-orm/sqlite-core'

// Common fields
const id = text('id').primaryKey().notNull()
const timestamps = {
	createdAt: integer('created_at', { mode: 'timestamp' }).default(sql\`(unixepoch())\`).notNull(),
	updatedAt: integer('updated_at', { mode: 'timestamp' }).default(sql\`(unixepoch())\`).notNull(),
}

export const user = sqliteTable('user', {
	id,
	email: text('email').notNull().unique(),
	emailVerified: integer('email_verified', { mode: 'timestamp' }),
	name: text('name'),
	image: text('image'),
	role: text('role', { enum: ['user', 'admin'] }).default('user'),
	isActive: integer('is_active', { mode: 'boolean' }).default(true),
	...timestamps,
})

export const account = sqliteTable('account', {
	id,
	userId: text('user_id').notNull().references(() => user.id, { onDelete: 'cascade' }),
	type: text('type').notNull(),
	provider: text('provider').notNull(),
	providerAccountId: text('provider_account_id').notNull(),
	refreshToken: text('refresh_token'),
	accessToken: text('access_token'),
	expiresAt: integer('expires_at', { mode: 'timestamp' }),
	tokenType: text('token_type'),
	scope: text('scope'),
	idToken: text('id_token'),
	sessionState: text('session_state'),
	...timestamps,
})

export const session = sqliteTable('session', {
	id,
	sessionToken: text('session_token').notNull().unique(),
	userId: text('user_id').notNull().references(() => user.id, { onDelete: 'cascade' }),
	expires: integer('expires', { mode: 'timestamp' }).notNull(),
	...timestamps,
})
`

	commands.push({
		content: userSchema,
		file: 'app/db/schema/user.ts',
		type: 'create',
	})

	// Schema index file
	const schemaIndex = `export * from './user'
`

	commands.push({
		content: schemaIndex,
		file: 'app/db/schema/index.ts',
		type: 'create',
	})

	return commands
}
