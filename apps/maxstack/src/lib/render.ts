/**
 * Template rendering: copy a template directory into a target and substitute
 * {{TOKEN}} placeholders in text files.
 *
 * Two niceties beyond a plain copy:
 *   - Files ending in `.template` are renamed to drop that suffix after copy
 *     (so `prd.ts.template` ships as `prd.ts` but never gets mistaken for real
 *     source inside the hub).
 *   - `gitignore` is shipped as `gitignore` in templates and renamed to
 *     `.gitignore` on render — npm/git tooling strips dotfiles from packages.
 */
import { readdir, readFile } from 'node:fs/promises'
import { join, relative } from 'node:path'
import { copyFile, ensureDir, outputFile, pathExists } from '../fsx.ts'

export type Tokens = Record<string, string>

const TEMPLATE_SUFFIX = '.template'

/** Replace every {{KEY}} occurrence with tokens[KEY]; unknown tokens are left intact. */
export function substitute(content: string, tokens: Tokens): string {
	return content.replace(/\{\{(\w+)\}\}/g, (match, key: string) =>
		key in tokens ? tokens[key]! : match,
	)
}

// Extensions we treat as binary — copied verbatim, never token-substituted.
const BINARY_EXT = new Set([
	'.png',
	'.jpg',
	'.jpeg',
	'.gif',
	'.webp',
	'.ico',
	'.woff',
	'.woff2',
	'.ttf',
	'.otf',
	'.eot',
	'.pdf',
	'.zip',
	'.gz',
])

function isBinary(path: string): boolean {
	const dot = path.lastIndexOf('.')
	return dot >= 0 && BINARY_EXT.has(path.slice(dot).toLowerCase())
}

function targetName(name: string): string {
	if (name === 'gitignore') return '.gitignore'
	if (name === 'npmignore') return '.npmignore'
	if (name.endsWith(TEMPLATE_SUFFIX)) {
		return name.slice(0, -TEMPLATE_SUFFIX.length)
	}
	return name
}

/**
 * Recursively copy `srcDir` into `destDir`, renaming dotfile stand-ins and
 * `.template` files, and substituting tokens in every text file.
 */
export async function renderTemplate(
	srcDir: string,
	destDir: string,
	tokens: Tokens,
): Promise<void> {
	if (!(await pathExists(srcDir))) {
		throw new Error(`Template directory not found: ${srcDir}`)
	}

	const entries = await readdir(srcDir, { withFileTypes: true })
	await ensureDir(destDir)

	for (const entry of entries) {
		const from = join(srcDir, entry.name)
		const to = join(destDir, targetName(entry.name))

		if (entry.isDirectory()) {
			await renderTemplate(from, to, tokens)
		} else if (entry.isFile()) {
			if (isBinary(from)) {
				await copyFile(from, to)
			} else {
				const raw = await readFile(from, 'utf8')
				await outputFile(to, substitute(raw, tokens))
			}
		}
	}
}

/** Human-readable list of files a render produced, for the success summary. */
export async function listFiles(dir: string): Promise<string[]> {
	const out: string[] = []
	async function walk(d: string) {
		for (const e of await readdir(d, { withFileTypes: true })) {
			const p = join(d, e.name)
			if (e.isDirectory()) await walk(p)
			else out.push(relative(dir, p))
		}
	}
	await walk(dir)
	return out.sort()
}
