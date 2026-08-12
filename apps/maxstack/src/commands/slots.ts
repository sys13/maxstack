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
	BLOCK_SLOT_ID_ESCAPING,
	blockSlotsForResource,
	createNodeFs,
	exportedSlotNames,
	fillBlockSlot,
	MANIFEST_FILENAME,
	pageFilePaths,
	parseBlockSlotId,
	parseManifest,
	serializeManifest,
} from '@maxstack/core/ownership'
import { type SlotInfo, slotInventory } from '@maxstack/mcp'
import type { SpecSystem } from '@maxstack/spec'
import { slotChoices } from '../lib/choices.ts'
import { loadProject, type Project } from '../lib/project.ts'
import { type Interaction, nonInteractive, resolveArg } from '../lib/prompt.ts'

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

/** Soft-wrap a prose line so it reads as a paragraph beside the id table. */
function wrap(text: string, width = 78): string {
	const lines: string[] = []
	let line = ''
	for (const word of text.split(' ')) {
		if (line === '') line = word
		else if (line.length + 1 + word.length <= width) line += ` ${word}`
		else {
			lines.push(line)
			line = word
		}
	}
	if (line !== '') lines.push(line)
	return lines.join('\n')
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
		`Slots — bespoke UI without ejecting (block roles v${inventory.rolesVersion})`,
	)
	// `idEscaping` is a top-level field, so `--json` carries it for free — but a
	// table of ids would not, and the ids are exactly what reads as mangled
	// (#378). Backticks are markdown for the other two surfaces; strip them here.
	console.log(`${wrap(inventory.idEscaping.replaceAll('`', ''))}\n`)
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

/** Prefix every line, so a wrapped paragraph stays inside the error block. */
function indent(text: string, pad: string): string {
	return text
		.split('\n')
		.map((line) => pad + line)
		.join('\n')
}

/**
 * The slot id someone meant when they typed the *unescaped* spelling —
 * `reading-item__header` for `reading_ditem__header`.
 *
 * This is the one wrong id worth naming a repair for, because it is the id the
 * command itself teaches: a maintainer reads `reading-item` in their spec,
 * knows the slot is a header, and writes the two together. Matching is done by
 * decoding each real id back through `parseBlockSlotId` rather than by
 * re-escaping the typed string, so it costs nothing and cannot suggest an id
 * that does not exist.
 */
function unescapedSpelling(
	inventory: ReturnType<typeof slotInventory>,
	typed: string,
): string | undefined {
	for (const page of inventory.pages) {
		for (const slot of page.slots) {
			if (slot.kind !== 'block') continue
			const ref = parseBlockSlotId(slot.id)
			if (!ref) continue
			const spelled = [ref.resource, ref.role, ref.field]
				.filter((p): p is string => !!p)
				.join('__')
			if (spelled === typed) return slot.id
		}
	}
	return undefined
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
	id: string | undefined,
	dir: string | undefined,
	io: Interaction = nonInteractive,
): Promise<void> {
	const project = await loadProject(dir ?? '.')
	const spec = await project.spec.load()
	const inventory = slotInventory(spec, await filledByResource(project, spec))

	// The two rejections below — no such id, and "that is a declared page slot"
	// — are exactly what `slotChoices` filters out, so an id picked from the menu
	// cannot reach either (#421). Slot ids are also the worst thing in this CLI
	// to retype: they carry an escaping rule that `BLOCK_SLOT_ID_ESCAPING` needs
	// a paragraph to explain, and the error path below exists to explain it.
	const chosen = await resolveArg(id, 'id', io, (prompter) => {
		const choices = slotChoices(inventory)
		if (choices.length === 0) {
			throw new Error(
				'no unfilled block slots in this project — run `maxstack slots` to see what exists.',
			)
		}
		return prompter.select('Which slot do you want to fill?', choices)
	})

	const found = findSlot(inventory, chosen)

	if (!found) {
		console.error(`✖ no slot "${chosen}" in this project.`)
		// The caller who mistyped an id is exactly the caller who needs the escape
		// rule (#378, #390). A bare "not found" reads as *the id* being wrong, and
		// the likely next move — renaming the entity so its id stops looking
		// mangled — is the worse outcome. So: the repair first, then the rule.
		const suggestion = unescapedSpelling(inventory, chosen)
		if (suggestion) console.error(`  Did you mean "${suggestion}"?`)
		console.error(
			indent(wrap(BLOCK_SLOT_ID_ESCAPING.replaceAll('`', ''), 76), '  '),
		)
		console.error('  Run `maxstack slots` to see what is available.')
		process.exitCode = 1
		return
	}
	if (found.slot.kind !== 'block') {
		// A declared `slot:<name>` block is scaffolded by generation itself.
		console.error(
			`✖ "${chosen}" is a declared page slot, not a block slot — run \`maxstack gen\` and it is stubbed for you.`,
		)
		process.exitCode = 1
		return
	}

	const descriptor = blockSlotsForResource(
		found.resource,
		found.slot.field ? [found.slot.field] : [],
	).find((s) => s.id === chosen)
	if (!descriptor) {
		// Unreachable via the inventory, which is built from the same fold.
		console.error(`✖ could not derive slot "${chosen}"`)
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
		console.log(`· ${chosen} is already implemented in ${file} — nothing to do`)
		return
	}
	console.log(`✔ ${res.result.action} ${file}`)
	console.log(
		`  ${chosen}(props: ${descriptor.props}) — it is yours; edit freely.`,
	)
	console.log('  Regeneration will never overwrite this file.')
}
