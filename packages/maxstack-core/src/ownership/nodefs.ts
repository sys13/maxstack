/**
 * A `node:fs`-backed {@link Fs} — the disk adapter that lets the generator
 * pipeline (never-clobber writer, eject, `generateResourcePage`) land files in
 * a real project directory instead of the in-memory double. Closes the task-8
 * follow-up ("`node:fs` `Fs` adapter").
 *
 * Every path is resolved under `rootDir` and jailed there — a descriptor or
 * manifest can never write outside the project it was pointed at. The lazy
 * `node:fs` import keeps `@maxstack/core` importable in non-Node runtimes that
 * only use the pure machinery.
 */

import type { Fs } from './write.ts'

export function createNodeFs(rootDir: string): Fs {
	const resolveInRoot = async (path: string): Promise<string> => {
		const { resolve, sep } = await import('node:path')
		const root = resolve(rootDir)
		const full = resolve(root, path)
		if (full !== root && !full.startsWith(root + sep))
			throw new Error(`Path escapes project root: ${path}`)
		return full
	}
	return {
		async exists(path) {
			const { access } = await import('node:fs/promises')
			try {
				await access(await resolveInRoot(path))
				return true
			} catch {
				return false
			}
		},
		async read(path) {
			const { readFile } = await import('node:fs/promises')
			return readFile(await resolveInRoot(path), 'utf8')
		},
		async write(path, content) {
			const { mkdir, writeFile } = await import('node:fs/promises')
			const { dirname } = await import('node:path')
			const full = await resolveInRoot(path)
			await mkdir(dirname(full), { recursive: true })
			await writeFile(full, content)
		},
		async remove(path) {
			const { rm } = await import('node:fs/promises')
			// `force` so a file the manifest tracks but that somebody already
			// deleted by hand is not an error: pruning is reconciliation, and the
			// desired end state is the same either way. Files only — a generator
			// never owns a directory, and `recursive` here would turn a bad path
			// into an unbounded delete.
			await rm(await resolveInRoot(path), { force: true })
		},
	}
}
