import fs from "fs/promises";
import path from "path";

// Types
export interface ExecuteServerCommandsResult {
	created: string[];
	edited: string[];
	errors: { error: unknown; file: string }[];
	updated: string[];
}

export interface ProjectInfo {
	config: null | string;
	dir: Record<string, unknown>;
	maxstackConfig?: MAXConfig | null;
	pkg: null | string;
	routes: null | string;
}

// Define MAXConfig interface
export interface MarketingPageConfig {
	component: string;
	description: string;
	name: string;
	route: string;
	template: string;
}

export interface MAXConfig {
	description: string;
	features?: string[];
	models?: string[];
	name: string;
	pages?: string[];
	personas?: string[];
	standardFeatures?: string[];
}

export interface ServerCommand {
	content?: string;
	file: string;
	type: "create" | "edit" | "send file info" | "update";
}

// Marketing pages configuration
const MARKETING_PAGES: MarketingPageConfig[] = [
	{
		component: "About",
		description: "Learn more about our company and mission",
		name: "about",
		route: "/about",
		template: "about",
	},
	{
		component: "Features",
		description: "Discover powerful features that help you manage tasks",
		name: "features",
		route: "/features",
		template: "features",
	},
	{
		component: "Contact",
		description: "Get in touch with our team",
		name: "contact",
		route: "/contact",
		template: "contact",
	},
	{
		component: "BlogLanding",
		description: "Read our latest insights and updates",
		name: "blog-landing",
		route: "/blog",
		template: "blogLanding",
	},
];

// Collects config, routes, package.json, and directory structure (excluding node_modules)
export async function collectProjectInfo(): Promise<ProjectInfo> {
	const root = process.cwd();
	console.error("[collectProjectInfo] root:", root);
	const [config, routes, pkg, dir, maxstackConfig] = await Promise.all([
		readIfExists(path.join(root, "tsdown.config.ts")),
		readIfExists(path.join(root, "template", "react-router.config.ts")),
		readIfExists(path.join(root, "package.json")),
		getDirectoryStructure(root, ["node_modules", ".git"]),
		loadMaxstackConfig(),
	]);
	console.error(
		"[collectProjectInfo] config:",
		config !== null ? "found" : "null",
	);
	console.error(
		"[collectProjectInfo] routes:",
		routes !== null ? "found" : "null",
	);
	console.error("[collectProjectInfo] pkg:", pkg !== null ? "found" : "null");
	console.error("[collectProjectInfo] dir keys:", Object.keys(dir));
	console.error(
		"[collectProjectInfo] maxstackConfig:",
		maxstackConfig !== null ? "found" : "null",
	);
	return { config, dir, maxstackConfig, pkg, routes };
}

async function readIfExists(filePath: string): Promise<null | string> {
	try {
		console.error("[readIfExists] Trying to read:", filePath);
		const data = await fs.readFile(filePath, "utf8");
		console.error("[readIfExists] Success:", filePath);
		return data;
	} catch {
		console.error("[readIfExists] Not found:", filePath);
		return null;
	}
}

// Recursively get directory structure, excluding specified folders
async function getDirectoryStructure(
	dir: string,
	exclude: string[] = [],
): Promise<Record<string, unknown>> {
	console.error("[getDirectoryStructure] Entering:", dir);
	const entries = await fs.readdir(dir, { withFileTypes: true });
	const structure: Record<string, unknown> = {};
	for (const entry of entries) {
		if (exclude.includes(entry.name)) {
			console.error("[getDirectoryStructure] Excluding:", entry.name);
			continue;
		}
		const fullPath = path.join(dir, entry.name);
		if (entry.isDirectory()) {
			console.error("[getDirectoryStructure] Directory:", fullPath);
			structure[entry.name] = await getDirectoryStructure(fullPath, exclude);
		} else {
			console.error("[getDirectoryStructure] File:", fullPath);
			structure[entry.name] = "file";
		}
	}
	return structure;
}

// Load and parse maxstack.tsx config
async function loadMaxstackConfig(): Promise<MAXConfig | null> {
	try {
		const configPath = path.join(process.cwd(), "maxstack.tsx");
		const configContent = await fs.readFile(configPath, "utf-8");

		// Extract the default export object
		const configRegex = /export default\s+\{[\s\S]*?\}\s+as const/;
		const configMatch = configRegex.exec(configContent);
		if (!configMatch) {
			console.error("[loadMaxstackConfig] Could not parse maxstack.tsx config");
			return null;
		}

		// For now, we'll check for the standardFeatures directly in the file
		const hasMarketing =
			configContent.includes("'saas-marketing'") ||
			configContent.includes('"saas-marketing"');

		// Parse basic config - in a real implementation you'd want proper parsing
		const nameRegex = /name:\s*"([^"]*)"/;
		const nameMatch = nameRegex.exec(configContent);
		const descRegex = /description:\s*"([^"]*)"/;
		const descMatch = descRegex.exec(configContent);

		return {
			description:
				descMatch?.[1] ??
				"A task management system for teams to manage their tasks and projects.",
			name: nameMatch?.[1] ?? "Taskly",
			standardFeatures: hasMarketing ? ["saas-marketing"] : [],
		} as MAXConfig;
	} catch (error) {
		console.error("[loadMaxstackConfig] Error loading config:", error);
		return null;
	}
}

// Generate commands locally based on project configuration
export function sendToServer(projectInfo: ProjectInfo): ServerCommand[] {
	const commands: ServerCommand[] = [];

	// Check if we should generate marketing pages
	if (
		projectInfo.maxstackConfig?.standardFeatures?.includes("saas-marketing")
	) {
		console.log(
			"✅ Found saas-marketing in standardFeatures. Generating marketing pages...",
		);
		commands.push(...generateMarketingPageCommands(projectInfo.maxstackConfig));
	} else {
		console.log(
			"❌ saas-marketing not found in standardFeatures. Skipping marketing page generation.",
		);
	}

	// Generate database schema commands
	commands.push(...generateDatabaseSchemaCommands());

	return commands;
}

async function safeWriteFile(file: string, content: string): Promise<boolean> {
	try {
		await fs.writeFile(file, content, "utf8");
		return true;
	} catch {
		// Ignore errors in mock mode (for test stability)
		return false;
	}
}

// Executes server commands
export async function executeServerCommands(
	commands: ServerCommand[],
	mockMode = false,
	outputDir?: string,
): Promise<ExecuteServerCommandsResult> {
	const workingDir = outputDir ?? process.cwd();
	const updated: string[] = [];
	const created: string[] = [];
	const edited: string[] = [];
	const errors: { error: unknown; file: string }[] = [];
	for (const cmd of commands) {
		try {
			// Use working directory (either temp or current) for all file operations
			const filePath = path.join(workingDir, cmd.file);

			// Ensure the directory exists before creating the file
			const fileDir = path.dirname(filePath);
			await fs.mkdir(fileDir, { recursive: true });

			switch (cmd.type) {
				case "create":
					if (mockMode) {
						await safeWriteFile(filePath, cmd.content ?? "");
					} else {
						await fs.writeFile(filePath, cmd.content ?? "", "utf8");
					}
					created.push(cmd.file);
					console.log(`Created ${cmd.file} in ${workingDir}`);
					break;
				case "edit":
					if (mockMode) {
						await safeWriteFile(filePath, cmd.content ?? "");
					} else {
						await fs.writeFile(filePath, cmd.content ?? "", "utf8");
					}
					edited.push(cmd.file);
					console.log(`Edited ${cmd.file} in ${workingDir}`);
					break;
				case "send file info":
					// No-op for now
					console.log(`Sent file info for ${cmd.file}`);
					break;
				case "update":
					if (mockMode) {
						await safeWriteFile(filePath, cmd.content ?? "");
					} else {
						await fs.writeFile(filePath, cmd.content ?? "", "utf8");
					}
					updated.push(cmd.file);
					console.log(`Updated ${cmd.file} in ${workingDir}`);
					break;
				default:
					console.warn("Unknown command:", cmd);
					break;
			}
		} catch (error) {
			errors.push({ error, file: cmd.file });
			console.error(`Error processing ${cmd.file}:`, error);
		}
	}
	return { created, edited, errors, updated };
}

// Generate marketing page commands
function generateMarketingPageCommands(config: MAXConfig): ServerCommand[] {
	const commands: ServerCommand[] = [];

	// Create route files for each marketing page
	for (const pageConfig of MARKETING_PAGES) {
		const routeContent = `import maxstack from 'maxstack'
import Template, { registry } from '~/components/templates/template'
import type { Route } from './+types/${pageConfig.name.replace("-", "_")}'

export function meta({}: Route.MetaArgs) {
	return [
		{ title: \`\${maxstack.name} - ${pageConfig.component}\` },
		{ name: 'description', content: '${pageConfig.description}' },
	]
}

export default function ${pageConfig.component}({}: Route.ComponentProps) {
	return (
		<Template
			componentName="${pageConfig.template}"
			props={{
				title: '${pageConfig.component}',
				description: '${pageConfig.description}',
			}}
		/>
	)
}
`;
		commands.push({
			content: routeContent,
			file: `app/routes/${pageConfig.name.replace("-", "_")}.tsx`,
			type: "create",
		});
	}

	// Update routes.ts file
	const newRoutes = MARKETING_PAGES.map(
		(page) =>
			`\troute('${page.route}', 'routes/${page.name.replace("-", "_")}.tsx'),`,
	).join("\n");

	const routesUpdateContent = `// Add these routes to your routes.ts file after the pricing route:
${newRoutes}`;

	commands.push({
		content: routesUpdateContent,
		file: "app/routes-marketing-addition.txt",
		type: "create",
	});

	// Generate sample marketing data
	const sampleData = {
		about: {
			mission:
				"To help teams manage their tasks and projects more efficiently with intuitive, powerful tools.",
			team: [
				{
					avatar: "/images/team/alex.jpg",
					bio: "Passionate about productivity and team collaboration",
					name: "Alex Johnson",
					role: "CEO & Founder",
				},
				{
					avatar: "/images/team/sarah.jpg",
					bio: "Full-stack developer with expertise in React and Node.js",
					name: "Sarah Chen",
					role: "Lead Developer",
				},
			],
		},
		blog: {
			posts: [
				{
					author: "Alex Johnson",
					publishedAt: new Date().toISOString(),
					readingMinutes: 5,
					slug: "5-tips-better-task-management",
					summary:
						"Learn how to organize your tasks more effectively with these proven strategies.",
					tags: ["productivity", "tips", "organization"],
					title: "5 Tips for Better Task Management",
				},
			],
		},
		contact: {
			address: "123 Business St, Suite 100, San Francisco, CA 94105",
			email: `hello@${config.name.toLowerCase()}.com`,
			phone: "+1 (555) 123-4567",
		},
		features: {
			features: [
				{
					benefits: [
						"Easy task creation",
						"Priority management",
						"Due date tracking",
					],
					description: "Create, organize, and track tasks with ease",
					icon: "✓",
					name: "Task Management",
				},
				{
					benefits: [
						"Project templates",
						"Task dependencies",
						"Progress tracking",
					],
					description:
						"Group related tasks into projects for better organization",
					icon: "📋",
					name: "Project Organization",
				},
			],
		},
	};

	const dataContent = `// Sample data for marketing pages
export const marketingData = ${JSON.stringify(sampleData, null, 2)}
`;

	commands.push({
		content: dataContent,
		file: "app/data/marketing.ts",
		type: "create",
	});

	return commands;
}

// Generate database schema commands
function generateDatabaseSchemaCommands(): ServerCommand[] {
	const commands: ServerCommand[] = [];

	// Users schema
	const usersSchema = `import { sql } from 'drizzle-orm'
import { pgTable, serial, text, timestamp, boolean, uuid } from 'drizzle-orm/pg-core'

export const users = pgTable('users', {
	id: uuid('id').defaultRandom().primaryKey(),
	email: text('email').notNull().unique(),
	emailVerified: timestamp('email_verified'),
	name: text('name'),
	image: text('image'),
	role: text('role', { enum: ['user', 'admin'] }).default('user'),
	isActive: boolean('is_active').default(true),
	createdAt: timestamp('created_at').default(sql\`now()\`),
	updatedAt: timestamp('updated_at').default(sql\`now()\`),
})

export const accounts = pgTable('accounts', {
	id: uuid('id').defaultRandom().primaryKey(),
	userId: uuid('user_id').notNull().references(() => users.id, { onDelete: 'cascade' }),
	type: text('type').notNull(),
	provider: text('provider').notNull(),
	providerAccountId: text('provider_account_id').notNull(),
	refresh_token: text('refresh_token'),
	access_token: text('access_token'),
	expires_at: timestamp('expires_at'),
	token_type: text('token_type'),
	scope: text('scope'),
	id_token: text('id_token'),
	session_state: text('session_state'),
	createdAt: timestamp('created_at').default(sql\`now()\`),
})

export const sessions = pgTable('sessions', {
	id: uuid('id').defaultRandom().primaryKey(),
	sessionToken: text('session_token').notNull().unique(),
	userId: uuid('user_id').notNull().references(() => users.id, { onDelete: 'cascade' }),
	expires: timestamp('expires').notNull(),
	createdAt: timestamp('created_at').default(sql\`now()\`),
})
`;

	commands.push({
		content: usersSchema,
		file: "database/schema/users.ts",
		type: "create",
	});

	// Organizations schema
	const orgsSchema = `import { sql } from 'drizzle-orm'
import { pgTable, text, timestamp, uuid, integer } from 'drizzle-orm/pg-core'
import { users } from './users'

export const organizations = pgTable('organizations', {
	id: uuid('id').defaultRandom().primaryKey(),
	name: text('name').notNull(),
	slug: text('slug').notNull().unique(),
	description: text('description'),
	logo: text('logo'),
	website: text('website'),
	createdBy: uuid('created_by').notNull().references(() => users.id),
	createdAt: timestamp('created_at').default(sql\`now()\`),
	updatedAt: timestamp('updated_at').default(sql\`now()\`),
})

export const organizationMembers = pgTable('organization_members', {
	id: uuid('id').defaultRandom().primaryKey(),
	organizationId: uuid('organization_id').notNull().references(() => organizations.id, { onDelete: 'cascade' }),
	userId: uuid('user_id').notNull().references(() => users.id, { onDelete: 'cascade' }),
	role: text('role', { enum: ['owner', 'admin', 'member'] }).default('member'),
	joinedAt: timestamp('joined_at').default(sql\`now()\`),
})

export const invitations = pgTable('invitations', {
	id: uuid('id').defaultRandom().primaryKey(),
	organizationId: uuid('organization_id').notNull().references(() => organizations.id, { onDelete: 'cascade' }),
	email: text('email').notNull(),
	role: text('role', { enum: ['admin', 'member'] }).default('member'),
	token: text('token').notNull().unique(),
	expiresAt: timestamp('expires_at').notNull(),
	invitedBy: uuid('invited_by').notNull().references(() => users.id),
	createdAt: timestamp('created_at').default(sql\`now()\`),
})
`;

	commands.push({
		content: orgsSchema,
		file: "database/schema/organizations.ts",
		type: "create",
	});

	// Tasks schema (example business logic)
	const tasksSchema = `import { sql } from 'drizzle-orm'
import { pgTable, text, timestamp, uuid, boolean, integer } from 'drizzle-orm/pg-core'
import { users } from './users'
import { organizations } from './organizations'

export const projects = pgTable('projects', {
	id: uuid('id').defaultRandom().primaryKey(),
	name: text('name').notNull(),
	description: text('description'),
	organizationId: uuid('organization_id').references(() => organizations.id, { onDelete: 'cascade' }),
	createdBy: uuid('created_by').notNull().references(() => users.id),
	createdAt: timestamp('created_at').default(sql\`now()\`),
	updatedAt: timestamp('updated_at').default(sql\`now()\`),
})

export const tasks = pgTable('tasks', {
	id: uuid('id').defaultRandom().primaryKey(),
	title: text('title').notNull(),
	description: text('description'),
	status: text('status', { enum: ['todo', 'in_progress', 'done', 'cancelled'] }).default('todo'),
	priority: text('priority', { enum: ['low', 'medium', 'high', 'urgent'] }).default('medium'),
	projectId: uuid('project_id').references(() => projects.id, { onDelete: 'cascade' }),
	assigneeId: uuid('assignee_id').references(() => users.id),
	createdBy: uuid('created_by').notNull().references(() => users.id),
	dueDate: timestamp('due_date'),
	completedAt: timestamp('completed_at'),
	createdAt: timestamp('created_at').default(sql\`now()\`),
	updatedAt: timestamp('updated_at').default(sql\`now()\`),
})

export const comments = pgTable('comments', {
	id: uuid('id').defaultRandom().primaryKey(),
	content: text('content').notNull(),
	taskId: uuid('task_id').notNull().references(() => tasks.id, { onDelete: 'cascade' }),
	authorId: uuid('author_id').notNull().references(() => users.id),
	createdAt: timestamp('created_at').default(sql\`now()\`),
	updatedAt: timestamp('updated_at').default(sql\`now()\`),
})
`;

	commands.push({
		content: tasksSchema,
		file: "database/schema/tasks.ts",
		type: "create",
	});

	// Main schema index file
	const schemaIndex = `export * from './users'
export * from './organizations'
export * from './tasks'
`;

	commands.push({
		content: schemaIndex,
		file: "database/schema/index.ts",
		type: "create",
	});

	// Update main schema.ts to include new schemas
	const mainSchemaUpdate = `// Import all schemas
export * from './schema/users'
export * from './schema/organizations'
export * from './schema/tasks'

// Import for relations if needed
import { users } from './schema/users'
import { organizations, organizationMembers } from './schema/organizations'
import { projects, tasks } from './schema/tasks'

// You can define relations here if using Drizzle relations
`;

	commands.push({
		content: mainSchemaUpdate,
		file: "database/schema-update-example.ts",
		type: "create",
	});

	return commands;
}
