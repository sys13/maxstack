import fs from 'fs/promises'

// Define MAXConfig interface
export interface MarketingPageConfig {
	component: string
	description: string
	name: string
	route: string
	template: string
}

export async function readIfExists(filePath: string): Promise<null | string> {
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
