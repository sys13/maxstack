/**
 * `maxstack review` — what needs you, in the terminal.
 *
 *: the workbench is the best surface, never the only one. That rule is
 * load-bearing here rather than ceremonial, because the browser workbench is the
 * one surface that had grown genuinely browser-only capabilities — the exposure
 * view among them, which #198 calls the single most important thing a human
 * should review. A public-boundary report you can only see by opening Chrome is a
 * public-boundary report that does not get seen.
 *
 * The ordering is not re-implemented here. `attentionReport` is the same fold the
 * pane and the MCP tool run, so the three surfaces cannot disagree about what
 * matters most — the failure #199 hit when two hosts each computed their own
 * answer to the same question.
 */

import { describeCatalog } from '@maxstack/features/bundle'
import {
	type AttentionInputs,
	attentionReport,
	blastRadius,
	deriveSurfaces,
	latentExposure,
	specIfAllAccepted,
} from '@maxstack/mcp'
import type { SpecSystem } from '@maxstack/spec'
import { projectDrift } from '../lib/generate.ts'
import { loadProject, type Project } from '../lib/project.ts'
import { ownershipRiskContext } from '../lib/review-risk.ts'

interface WorkbenchOptions {
	json?: boolean
	/** `--section exposure` / `--section blast-radius`; default is the attention list. */
	section?: string
}

/** Marks for the ordered list — severity readable without colour. */
const MARK: Record<string, string> = {
	'public-change': '!! PUBLIC',
	removal: '!! REMOVES',
	unbatchable: ' ! ',
	'latent-exposure': ' ~ LATENT',
	drift: ' ~ DRIFT',
	routine: '   ',
}

/**
 * Everything this host can see, for the shared report.
 *
 * Each fact is gathered in its own `try`, deliberately: a failure to read the
 * bundle catalog must not cost the reviewer the drift report. Whatever is missing
 * comes back absent, and `attentionReport` names it as unevaluated rather than
 * letting a partial answer read as an all-clear.
 */
async function gatherInputs(
	project: Project,
	spec: SpecSystem,
): Promise<AttentionInputs> {
	const inputs: AttentionInputs = {
		risk: await ownershipRiskContext(project, spec),
	}
	try {
		const report = await projectDrift(project, spec)
		inputs.drift = report.owned.map((owned) => ({
			id: owned.id,
			file: owned.file,
			drifted: owned.status === 'drifted',
		}))
	} catch {
		// Left absent — see the docblock.
	}
	try {
		// `installed.upgradeTo` is set by `availableUpgrade` only when the installed
		// version is genuinely behind, so its presence IS the "upgrade available"
		// fact — there is no separate flag to keep in step with it.
		inputs.upgrades = describeCatalog(project.config.bundles).flatMap((m) =>
			m.installed?.upgradeTo
				? [
						{
							slug: m.slug,
							from: m.installed.version,
							to: m.installed.upgradeTo,
						},
					]
				: [],
		)
	} catch {
		// Left absent.
	}
	return inputs
}

function printAttention(
	report: ReturnType<typeof attentionReport>,
	pending: number,
): void {
	console.log(`\n  ${report.headline}\n`)
	for (const item of report.items) {
		console.log(`  ${MARK[item.kind] ?? '   '}  ${item.title}`)
		// The reason travels with the item on every surface. A ranked list whose
		// ranking cannot be explained is a ranking nobody trusts.
		console.log(`            ${item.because}`)
		if (item.where) console.log(`            → ${item.where}`)
	}
	if (report.items.length === 0) console.log('  (nothing listed)')
	console.log(`\n  ${pending} proposal${pending === 1 ? '' : 's'} pending.`)
	if (report.unavailable.length > 0) {
		// Printed, not swallowed: this is the difference between "clean" and "not
		// looked at", and they are indistinguishable without it.
		console.log('\n  NOT CHECKED:')
		for (const gap of report.unavailable) console.log(`    - ${gap}`)
	}
	console.log(
		'\n  clear the routine ones:  maxstack review --accept <selector>' +
			'\n  what is public:          maxstack review --section exposure' +
			'\n  what accepting does:     maxstack review --section blast-radius',
	)
}

function printExposure(spec: SpecSystem): void {
	const surfaces = deriveSurfaces(spec).filter(
		(s) => s.kind === 'public-field' || s.kind === 'public-write',
	)
	const latent = latentExposure(spec)

	if (surfaces.length === 0 && latent.length === 0) {
		console.log(
			'\n  No portal declares anything. Nothing in this project is publicly reachable.\n',
		)
		return
	}
	console.log(`\n  PUBLIC RIGHT NOW (${surfaces.length}):`)
	for (const surface of surfaces) {
		console.log(`    ${surface.label.replace(/\*\*/g, '')}`)
		if (surface.detail) console.log(`      ${surface.detail}`)
	}
	if (latent.length > 0) {
		console.log(`\n  ONE OP FROM PUBLIC (${latent.length}):`)
		for (const item of latent) {
			console.log(
				`    ${item.key} over ${item.entityId} — ${item.fields} field${item.fields === 1 ? '' : 's'}`,
			)
			console.log(`      ${item.reason}`)
		}
	}
	console.log()
}

function printBlastRadius(spec: SpecSystem, inputs: AttentionInputs): void {
	const radius = blastRadius(spec, specIfAllAccepted(spec, inputs.risk ?? {}))
	console.log(`\n  If you accept everything pending: ${radius.summary}\n`)
	if (radius.groundingNote) console.log(`  ${radius.groundingNote}\n`)
	for (const [heading, list] of [
		['REMOVES', radius.removed],
		['adds', radius.added],
	] as const) {
		if (list.length === 0) continue
		console.log(`  ${heading} (${list.length}):`)
		for (const surface of list) {
			console.log(`    ${surface.label.replace(/\*\*/g, '')}`)
			if (surface.detail) console.log(`      ${surface.detail}`)
		}
	}
	if (radius.changed.length > 0) {
		console.log(`  changes (${radius.changed.length}):`)
		for (const change of radius.changed) {
			console.log(`    ${change.surface.label.replace(/\*\*/g, '')}`)
			console.log(`      ${change.before ?? '—'}  →  ${change.after ?? '—'}`)
		}
	}
	console.log(`\n  ${radius.unchanged} derived surface(s) unchanged.\n`)
}

export async function workbenchCommand(
	dir: string | undefined,
	opts: WorkbenchOptions = {},
): Promise<void> {
	const project = await loadProject(dir ?? '.')
	const spec = await project.spec.load()
	const inputs = await gatherInputs(project, spec)

	if (opts.section === 'exposure') {
		if (opts.json) {
			console.log(
				JSON.stringify(
					{
						public: deriveSurfaces(spec).filter((s) =>
							s.kind.startsWith('public'),
						),
						latent: latentExposure(spec),
					},
					null,
					2,
				),
			)
			return
		}
		printExposure(spec)
		return
	}

	if (opts.section === 'blast-radius') {
		const radius = blastRadius(spec, specIfAllAccepted(spec, inputs.risk ?? {}))
		if (opts.json) {
			console.log(JSON.stringify(radius, null, 2))
			return
		}
		printBlastRadius(spec, inputs)
		return
	}

	const report = attentionReport(spec, {
		...inputs,
		ifAccepted: specIfAllAccepted(spec, inputs.risk ?? {}),
	})
	if (opts.json) {
		console.log(JSON.stringify(report, null, 2))
		return
	}
	printAttention(report, report.pending)
}
