import fs from 'fs/promises'
import path from 'path'

// Define MAXConfig interface
export interface MarketingPageConfig {
	component: string
	description: string
	name: string
	route: string
	template: string
}

// Marketing pages configuration
const MARKETING_PAGES: MarketingPageConfig[] = [
	{
		component: 'About',
		description: 'Learn more about our company and mission',
		name: 'about',
		route: '/about',
		template: 'about',
	},
	{
		component: 'Features',
		description: 'Discover powerful features that help you manage tasks',
		name: 'features',
		route: '/features',
		template: 'features',
	},
	{
		component: 'Contact',
		description: 'Get in touch with our team',
		name: 'contact',
		route: '/contact',
		template: 'contact',
	},
	{
		component: 'BlogLanding',
		description: 'Read our latest insights and updates',
		name: 'blog-landing',
		route: '/blog',
		template: 'blogLanding',
	},
]

async function readIfExists(filePath: string): Promise<null | string> {
	try {
		console.error('[readIfExists] Trying to read:', filePath)
		const data = await fs.readFile(filePath, 'utf8')
		console.error('[readIfExists] Success:', filePath)
		return data
	} catch {
		console.error('[readIfExists] Not found:', filePath)
		return null
	}
}

// Recursively get directory structure, excluding specified folders
async function getDirectoryStructure(
	dir: string,
	exclude: string[] = [],
): Promise<Record<string, unknown>> {
	console.error('[getDirectoryStructure] Entering:', dir)
	const entries = await fs.readdir(dir, { withFileTypes: true })
	const structure: Record<string, unknown> = {}
	for (const entry of entries) {
		if (exclude.includes(entry.name)) {
			console.error('[getDirectoryStructure] Excluding:', entry.name)
			continue
		}
		const fullPath = path.join(dir, entry.name)
		if (entry.isDirectory()) {
			console.error('[getDirectoryStructure] Directory:', fullPath)
			structure[entry.name] = await getDirectoryStructure(fullPath, exclude)
		} else {
			console.error('[getDirectoryStructure] File:', fullPath)
			structure[entry.name] = 'file'
		}
	}
	return structure
}

// Generate marketing page commands
// function generateMarketingPageCommands(config: MAXConfig): ServerCommand[] {

// 	// Create route files for each marketing page
// 	for (const pageConfig of MARKETING_PAGES) {
// 		const routeContent = `import maxstack from 'maxstack'
// import Template, { registry } from '~/components/templates/template'
// import type { Route } from './+types/${pageConfig.name.replace('-', '_')}'

// export function meta({}: Route.MetaArgs) {
// 	return [
// 		{ title: \`\${maxstack.name} - ${pageConfig.component}\` },
// 		{ name: 'description', content: '${pageConfig.description}' },
// 	]
// }

// export default function ${pageConfig.component}({}: Route.ComponentProps) {
// 	return (
// 		<Template
// 			componentName="${pageConfig.template}"
// 			props={{
// 				title: '${pageConfig.component}',
// 				description: '${pageConfig.description}',
// 			}}
// 		/>
// 	)
// }
// `
