/**
 * The never-clobber writer + eject. Every write to a project goes through here so the manifest is the
 * single authority on what may be overwritten.
 *
 * Filesystem access is injected as a tiny {@link Fs} port so the whole thing is
 * testable in memory and stays free of a hard `node:fs` dependency in the L2
 * runtime. The CLI passes a `node:fs/promises`-backed adapter.
 */

import {
	findEntry,
	hashContent,
	type Ownership,
	type RouteManifest,
	type RouteManifestEntry,
	upsertEntry,
} from './manifest.ts'

/** Minimal async filesystem port. */
export interface Fs {
	exists(path: string): Promise<boolean>
	read(path: string): Promise<string>
	write(path: string, content: string): Promise<void>
}

export interface WriteResult {
	file: string
	/** What the writer decided to do. */
	action:
		| 'created'
		| 'overwritten'
		| 'skipped-user-owned'
		| 'unchanged'
		| 'appended'
	ownership: Ownership
}

/**
 * Write a framework-generated file, honoring ownership:
 *   - `ejected` / `user` entries are NEVER overwritten (skipped).
 *   - an unchanged `generated` file is left alone (no spurious writes).
 *   - otherwise the file is written and its hash recorded in the manifest.
 *
 * Returns the (possibly updated) manifest and a per-file result. Pure w.r.t. the
 * manifest — callers persist the returned value.
 */
export async function writeGenerated(
	fs: Fs,
	manifest: RouteManifest,
	entry: Omit<RouteManifestEntry, 'ownership' | 'hash'>,
	content: string,
): Promise<{ manifest: RouteManifest; result: WriteResult }> {
	const existing = findEntry(manifest, entry.id)

	if (existing && existing.ownership !== 'generated') {
		return {
			manifest,
			result: {
				file: entry.file,
				action: 'skipped-user-owned',
				ownership: existing.ownership,
			},
		}
	}

	const hash = hashContent(content)
	if (existing?.hash === hash && (await fs.exists(entry.file))) {
		return {
			manifest,
			result: { file: entry.file, action: 'unchanged', ownership: 'generated' },
		}
	}

	const existedOnDisk = await fs.exists(entry.file)
	await fs.write(entry.file, content)
	const next = upsertEntry(manifest, {
		...entry,
		ownership: 'generated',
		hash,
	})
	return {
		manifest: next,
		result: {
			file: entry.file,
			action: existedOnDisk ? 'overwritten' : 'created',
			ownership: 'generated',
		},
	}
}

/**
 * Write a user-owned file (e.g. a slot stub) ONCE. If it already exists on
 * disk, or the manifest already tracks it as `user`/`ejected`, it is left
 * untouched — the user owns it. This is how the generator seeds a slot file the
 * first time without ever clobbering the user's later edits.
 */
export async function writeUserFileOnce(
	fs: Fs,
	manifest: RouteManifest,
	id: string,
	file: string,
	content: string,
): Promise<{ manifest: RouteManifest; result: WriteResult }> {
	const existing = manifest.entries.find((e) => e.file === file)
	if ((await fs.exists(file)) || existing) {
		return {
			manifest,
			result: { file, action: 'skipped-user-owned', ownership: 'user' },
		}
	}
	await fs.write(file, content)
	const next = upsertEntry(manifest, {
		id: `${id}:slot`,
		routePath: '',
		file,
		ownership: 'user',
	})
	return {
		manifest: next,
		result: { file, action: 'created', ownership: 'user' },
	}
}

export const EJECT_BANNER = [
	'// EJECTED — you own this file now. maxstack will never overwrite or',
	'// regenerate it, and it no longer receives framework improvements',
	'// (the "eject tax"). Prefer a slot or a spec op where one exists.',
].join('\n')

/**
 * Eject a generated route: copy-with-banner into a user-owned location and flip
 * the manifest entry to `ejected`. Never clobbers — if a *different* destination
 * already exists it is left as-is (the user already owns it). After this the
 * entry is frozen against regeneration.
 *
 * **In place is the default, and it is not the clobber case**.
 * `maxstack eject <id>` with no `--to` passes `destFile === entry.file`, which
 * by definition exists: it is the framework's own generated module. Skipping the
 * write there — as this did until #232 — left the file carrying
 * `AUTO-GENERATED … DO NOT EDIT, regeneration overwrites this file`, which the
 * manifest had just made false, and never wrote the one line in the file that
 * says the eject tax has been paid. Rewriting the banner in place clobbers
 * nothing, because the bytes being replaced are the ones the generator wrote.
 *
 * Lineage: mx_1/saaskit-one-ejectable `eject` (copies-with-banner, skips
 * existing). Reimplemented on the injected Fs port.
 */
export async function eject(
	fs: Fs,
	manifest: RouteManifest,
	id: string,
	destFile: string,
): Promise<{ manifest: RouteManifest; result: WriteResult }> {
	const entry = findEntry(manifest, id)
	if (!entry) throw new Error(`Cannot eject unknown route: ${id}`)
	if (entry.ownership === 'ejected') {
		return {
			manifest,
			result: {
				file: destFile,
				action: 'skipped-user-owned',
				ownership: 'ejected',
			},
		}
	}

	const inPlace = destFile === entry.file
	const destExists = !inPlace && (await fs.exists(destFile))
	if (!destExists) {
		const source = await fs.read(entry.file)
		await fs.write(destFile, `${EJECT_BANNER}\n${stripGeneratedBanner(source)}`)
	}
	const next = upsertEntry(manifest, {
		...entry,
		file: destFile,
		ownership: 'ejected',
	})
	return {
		manifest: next,
		result: {
			file: destFile,
			action: destExists
				? 'skipped-user-owned'
				: inPlace
					? 'overwritten'
					: 'created',
			ownership: 'ejected',
		},
	}
}

/** Drop a leading AUTO-GENERATED banner block so it isn't stacked on eject. */
function stripGeneratedBanner(source: string): string {
	const lines = source.split('\n')
	let i = 0
	while (i < lines.length && lines[i]?.startsWith('// ')) i++
	// Skip the blank line that follows the banner, if any.
	if (lines[i] === '') i++
	return lines.slice(i).join('\n')
}
