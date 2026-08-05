/**
 * The dev-server record: where `maxstack dev` writes down the port it is serving
 * on, inside the project's (gitignored) data dir.
 *
 * It exists because `maxstack demo` seeds *through* a running server: each dev
 * process holds its own pglite handle, so seeding the default port while the
 * server ran on another one reported success into a store nobody was looking
 * at. The record is also how a second `dev` is detected before it can open the
 * same single-writer store.
 *
 * Lifted out of `commands/harness.ts` so preflight can read it
 * without importing the command module that imports preflight.
 */

import { mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { resolve } from 'node:path'

/** Where `maxstack dev` records the port it's serving on. */
export function devServerFile(dataDir: string): string {
	return resolve(dataDir, 'dev-server.json')
}

/** A parsed dev-server record: the port `dev` serves on, plus its pid when the
 * record carries one (older records may not — `pid` is then `null`). */
export interface DevServerRecord {
	port: string
	pid: number | null
}

/** The recorded dev server, or `null` when there's no (readable) record. */
export async function readDevServerRecord(
	dataDir: string,
): Promise<DevServerRecord | null> {
	try {
		const parsed = JSON.parse(
			await readFile(devServerFile(dataDir), 'utf8'),
		) as { port?: unknown; pid?: unknown }
		if (typeof parsed.port !== 'string' || parsed.port === '') return null
		return {
			port: parsed.port,
			pid: typeof parsed.pid === 'number' ? parsed.pid : null,
		}
	} catch {
		return null
	}
}

/** The recorded dev-server port, or `null` when there's no (readable) record. */
export async function readDevServerPort(
	dataDir: string,
): Promise<string | null> {
	return (await readDevServerRecord(dataDir))?.port ?? null
}

/** Record this process as the project's dev server (pid kept for debugging). */
export async function writeDevServerFile(
	dataDir: string,
	port: string,
	pid = process.pid,
): Promise<void> {
	await mkdir(dataDir, { recursive: true })
	await writeFile(devServerFile(dataDir), `${JSON.stringify({ port, pid })}\n`)
}

/** Remove the record — or, when `onlyPid` is given, only if it still records
 * that pid (a newer `dev` may have overwritten it with its own). Best-effort:
 * a missing or unreadable record already counts as removed. */
export async function removeDevServerFile(
	dataDir: string,
	onlyPid?: number,
): Promise<void> {
	try {
		if (onlyPid !== undefined) {
			const parsed = JSON.parse(
				await readFile(devServerFile(dataDir), 'utf8'),
			) as { pid?: unknown }
			if (parsed.pid !== onlyPid) return
		}
		await rm(devServerFile(dataDir))
	} catch {
		// Nothing to remove (or nothing readable) — fine either way.
	}
}
