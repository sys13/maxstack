/**
 * `maxstack slots [dir]` / `maxstack slots fill <id> [dir]` — the discovery half
 * of block-level slots.
 *
 * A slot nobody can find does not lower any cost. Block slots are derived
 * rather than declared, so there is nothing in the spec file to read and
 * nothing in the generated route to grep — without this command a maintainer
 * facing a bespoke ask has no way to learn that ejecting is not their only
 * option, and the whole "cost 3 instead of 5" claim is theoretical.
 *
 * `slots` lists what exists and what is filled. `slots fill <id>` materializes
 * one: it appends a typed stub to the resource's user-owned slot file
 * (append-only — an id that is already implemented is a no-op) and registers
 * that file as owned so the build imports it.
 */

import {
	blockSlotsForResource,
	createNodeFs,
	exportedSlotNames,
	fillBlockSlot,
	MANIFEST_FILENAME,
	pageFilePaths,
	parseManifest,
	serializeManifest,
} from '@maxstack/core/ownership'
import { type SlotInfo, slotInventory } from '@maxstack/mcp'
import type { SpecSystem } from '@maxstack/spec'
import { loadProject, type Project } from '../lib/project.ts'

/**
 * What each resource's slot file exports, read straight off disk — the fill
 * state the spec cannot know. A resource with no slot file yet maps to `[]`,
 * which is "nothing filled", not "unknown".
 */
async function filledByResource(
	project: Project,
	spec: SpecSystem,
): Promise<Record<string, string[]>> {
	const fs = createNodeFs(project.appPath)
	const out: Record<string, string[]> = {}
	for (const page of spec.pages.pages) {
		if (!page.entityId) continue
		const resource = page.entityId.replace(/^e-/, '')
		if (out[resource]) continue
		const file = pageFilePaths(resource).slotFile
		out[resource] = (await fs.exists(file))
			? exportedSlotNames(await fs.read(file))
			: []
	}
	return out
}

export interface SlotsOptions {
	json?: boolean
}

export async function slotsCommand(
	dir: string | undefined,
	opts: SlotsOptions = {},
): Promise<void> {
	const project = await loadProject(dir ?? '.')
	const spec = await project.spec.load()
	const inventory = slotInventory(spec, await filledByResource(project, spec))

	if (opts.json) {
		console.log(JSON.stringify(inventory, null, 2))
		return
	}

	console.log(
		`Slots — bespoke UI without ejecting (block roles v${inventory.rolesVersion})\n`,
	)
	let filledCount = 0
	let total = 0
	for (const page of inventory.pages) {
		console.log(`${page.name}  ${page.route}`)
		if (page.slots.length === 0) {
			console.log('  (no slots — this page has no resource behind it)\n')
			continue
		}
		const width = Math.max(...page.slots.map((s) => s.id.length))
		for (const slot of page.slots) {
			total += 1
			if (slot.filled) filledCount += 1
			const mark = slot.filled ? '●' : '○'
			const props = slot.props ? `  (${slot.props})` : ''
			console.log(`  ${mark} ${slot.id.padEnd(width)}${props}`)
		}
		console.log()
	}
	console.log(`${filledCount} of ${total} filled (● filled · ○ available)`)
	console.log(
		'Fill one with: maxstack slots fill <id>   ·   or write the export yourself',
	)
}

/** Find a slot id across every page, so the user types one id and nothing else. */
function findSlot(
	inventory: ReturnType<typeof slotInventory>,
	id: string,
): { resource: string; slot: SlotInfo } | undefined {
	for (const page of inventory.pages) {
		const slot = page.slots.find((s) => s.id === id)
		if (slot && page.resource) return { resource: page.resource, slot }
	}
	return undefined
}

export async function slotsFillCommand(
	id: string,
	dir: string | undefined,
): Promise<void> {
	const project = await loadProject(dir ?? '.')
	const spec = await project.spec.load()
	const inventory = slotInventory(spec, await filledByResource(project, spec))
	const found = findSlot(inventory, id)

	if (!found) {
		console.error(`✖ no slot "${id}" in this project.`)
		console.error('  Run `maxstack slots` to see what is available.')
		process.exitCode = 1
		return
	}
	if (found.slot.kind !== 'block') {
		// A declared `slot:<name>` block is scaffolded by generation itself.
		console.error(
			`✖ "${id}" is a declared page slot, not a block slot — run \`maxstack gen\` and it is stubbed for you.`,
		)
		process.exitCode = 1
		return
	}

	const descriptor = blockSlotsForResource(
		found.resource,
		found.slot.field ? [found.slot.field] : [],
	).find((s) => s.id === id)
	if (!descriptor) {
		// Unreachable via the inventory, which is built from the same fold.
		console.error(`✖ could not derive slot "${id}"`)
		process.exitCode = 1
		return
	}

	const fs = createNodeFs(project.appPath)
	const manifest = (await fs.exists(MANIFEST_FILENAME))
		? parseManifest(await fs.read(MANIFEST_FILENAME))
		: { version: 1 as const, entries: [] }
	const res = await fillBlockSlot(fs, manifest, found.resource, descriptor)
	await fs.write(MANIFEST_FILENAME, serializeManifest(res.manifest))

	const file = pageFilePaths(found.resource).slotFile
	if (!res.added) {
		console.log(`· ${id} is already implemented in ${file} — nothing to do`)
		return
	}
	console.log(`✔ ${res.result.action} ${file}`)
	console.log(`  ${id}(props: ${descriptor.props}) — it is yours; edit freely.`)
	console.log('  Regeneration will never overwrite this file.')
}
