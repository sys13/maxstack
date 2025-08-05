import { transform } from 'esbuild'
import { readFile } from 'node:fs/promises'

export async function compileTsx(file: string) {
	const src = await readFile(file, 'utf8')

	const { code } = await transform(src, {
		format: 'esm',
		jsx: 'automatic',
		loader: 'tsx',
		minify: true,
		platform: 'neutral',
		target: 'es2022',
	})

	return code // plain JS string
}
