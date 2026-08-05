/**
 * Small filesystem helpers over `node:fs/promises`.
 *
 * The autofactory original leaned on `fs-extra`; on the Node 24 stack the few
 * value-adds we actually used (`pathExists`, JSON read/write, `ensureDir`,
 * `outputFile`) are a handful of lines, so we drop the dependency (decision
 * #13 — reimplement on the current stack).
 */
import {
	access,
	copyFile as fsCopyFile,
	mkdir,
	readFile,
	writeFile,
} from 'node:fs/promises'
import { dirname } from 'node:path'

/** True if a path exists (file or directory). */
export async function pathExists(path: string): Promise<boolean> {
	try {
		await access(path)
		return true
	} catch {
		return false
	}
}

/** Read and parse a JSON file. */
export async function readJSON<T = unknown>(path: string): Promise<T> {
	return JSON.parse(await readFile(path, 'utf8')) as T
}

/** Write a value as pretty JSON (2-space indent, trailing newline). */
export async function writeJSON(path: string, value: unknown): Promise<void> {
	await ensureDir(dirname(path))
	await writeFile(path, `${JSON.stringify(value, null, 2)}\n`, 'utf8')
}

/** Create a directory (and parents) if it does not exist. */
export async function ensureDir(path: string): Promise<void> {
	await mkdir(path, { recursive: true })
}

/** Copy a single file, creating the destination directory if needed. */
export async function copyFile(from: string, to: string): Promise<void> {
	await ensureDir(dirname(to))
	await fsCopyFile(from, to)
}

/** Write a text file, creating the destination directory if needed. */
export async function outputFile(path: string, content: string): Promise<void> {
	await ensureDir(dirname(path))
	await writeFile(path, content, 'utf8')
}
