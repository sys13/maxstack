/**
 * The ownership drift report for the workbench pane.
 *
 * The third surface of the same fold, alongside `maxstack drift` and the
 * `ownership_drift` MCP tool: all three call `ownershipDrift()` over
 * `regenTargets()`, so a human in the workbench and an agent calling the tool
 * cannot be told different things about the same file.
 *
 * Read from the project's own app directory rather than from the running
 * bundle's owned-code manifest — the opposite of what the slots pane does, and
 * deliberately so. The slots pane asks "does this fill actually render?", which
 * only what the bundle imports can answer. Drift asks "how far has the file on
 * disk fallen behind the derivation?", which only the file on disk can answer.
 *
 * A project with no `maxstack.json` above its data dir (a flat demo) has no app
 * directory and nothing ejected, so the report is empty rather than guessed.
 */

import { readFile, stat } from 'node:fs/promises'
import { resolve } from 'node:path'
import {
	generationWatermark,
	MANIFEST_FILENAME,
	type OwnershipDriftReport,
	ownershipDrift,
	parseManifest,
} from '@maxstack/core/ownership'
import { regenTargets } from '@maxstack/mcp'
import { resolveAppPath } from '~/data-dir.server'
import { getPlatform } from '~/sprout.server'

const EMPTY: OwnershipDriftReport = {
	owned: [],
	ownedCount: 0,
	driftedCount: 0,
	inSyncCount: 0,
	authoredCount: 0,
	underivedCount: 0,
	missingCount: 0,
	rolesDriftCount: 0,
}

export async function loadOwnershipDrift(): Promise<OwnershipDriftReport> {
	const appPath = resolveAppPath()
	if (!appPath) return EMPTY

	const fs = {
		async exists(path: string) {
			try {
				await stat(resolve(appPath, path))
				return true
			} catch {
				return false
			}
		},
		read: (path: string) => readFile(resolve(appPath, path), 'utf8'),
		// The drift report never writes; a throwing stub keeps that structural
		// rather than a promise made in a docblock.
		async write() {
			throw new Error('the drift report is read-only')
		},
	}

	if (!(await fs.exists(MANIFEST_FILENAME))) return EMPTY
	const manifest = parseManifest(await fs.read(MANIFEST_FILENAME))
	const spec = await getPlatform().spec.load()
	return ownershipDrift(fs, manifest, regenTargets(spec))
}

/**
 * How much of the op log this project was last generated from, or null if it
 * never has been.
 *
 * The workbench does not regenerate, so it cannot observe a `maxstack gen` while
 * it runs — but it can read what that run left behind, which is the same fact
 * one loader later. This is what stops the bulk-review pane offering an undo
 * whose precondition expired in another terminal.
 *
 * A missing app directory or an unreadable manifest returns null, meaning "no
 * generation recorded". That is the permissive direction, and it is the right
 * one here for the same reason it is wrong in `ownershipContext`: a project with
 * no app tree has nothing on disk derived from the decision, so there is nothing
 * for an undo to contradict.
 */
export async function loadGenerationWatermark(): Promise<number | null> {
	const appPath = resolveAppPath()
	if (!appPath) return null
	try {
		const raw = await readFile(resolve(appPath, MANIFEST_FILENAME), 'utf8')
		return generationWatermark(parseManifest(raw))
	} catch {
		return null
	}
}
