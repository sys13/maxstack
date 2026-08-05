/**
 * An in-memory {@link Fs} — the test double for the writer/eject/regen logic,
 * and the dry-run backend for the CLI's diff preview (nothing hits disk until a
 * reviewed diff is applied). Deliberately tiny; not a general VFS.
 */

import type { Fs } from './write.ts'

export interface MemFs extends Fs {
	/** Snapshot of the current file set (path → content). */
	snapshot(): Map<string, string>
}

export function createMemFs(seed: Record<string, string> = {}): MemFs {
	const files = new Map<string, string>(Object.entries(seed))
	return {
		async exists(path) {
			return files.has(path)
		},
		async read(path) {
			const v = files.get(path)
			if (v === undefined) throw new Error(`ENOENT: ${path}`)
			return v
		},
		async write(path, content) {
			files.set(path, content)
		},
		snapshot() {
			return new Map(files)
		},
	}
}
