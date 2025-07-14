import { transform } from 'esbuild'
import { Buffer } from 'node:buffer'
import { readFile } from 'node:fs/promises'

import { MAXConfig, MAXConfigSchema } from './msZod.js'

export async function parseMaxstack(pathToFile: string): Promise<MAXConfig> {
	const compiled = await compileTsx(pathToFile)
	const result = await execute(compiled) // may throw
	const config = MAXConfigSchema.parse(result) // strict validation

	return config
}

/** Turn a TSX file into plain ESM JS – no execution.  esbuild is ~50 ms. */
async function compileTsx(absPath: string): Promise<string> {
	const src = await readFile(absPath, 'utf8')
	const { code } = await transform(src, {
		format: 'esm',
		jsx: 'automatic',
		loader: 'tsx',
		minify: true,
		platform: 'neutral',
		target: 'es2022',
	}) //  [oai_citation:1‡esbuild.github.io](https://esbuild.github.io/api/?utm_source=chatgpt.com)
	return code
}

/** Evaluate the compiled JS by importing a `data:` URL (keeps disk clean). */
async function execute(code: string): Promise<string> {
	const dataUrl =
		'data:text/javascript;base64,' + Buffer.from(code).toString('base64')
	// eslint-disable-next-line @typescript-eslint/no-unsafe-assignment
	const mod = await import(dataUrl) // dynamic import → ESM context
	// eslint-disable-next-line @typescript-eslint/no-unsafe-assignment
	const value =
		// eslint-disable-next-line @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-call
		typeof mod.default === 'function' ? await mod.default() : mod.default

	// eslint-disable-next-line @typescript-eslint/no-unsafe-return
	return value
}
