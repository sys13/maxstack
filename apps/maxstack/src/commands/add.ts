/**
 * `maxstack add <bundle> [dir]` — install a feature bundle into a project. A
 * bundle's runtime is folded into the project spec through the *same* validated
 * spec-op path an agent uses (`applyBundle` → `applyOp`), so adding schema/pages
 * is never a bespoke mutation. Prerequisites are resolved over the catalog and
 * installed first; each install is recorded in `maxstack.json` (`bundles`), and
 * the app tree is regenerated so new pages are immediately navigable.
 *
 * Seeds are NOT applied here (the store may not exist yet at add time): they are
 * loaded at dev boot from the recorded install list, via the db-plugins registry
 * seam — see the composition root (`apps/web/app/sprout.server.ts`).
 */

import {
	applyBundle,
	BUNDLES,
	type BundleSummary,
	describeCatalog,
	getBundle,
	type InstalledBundle,
	previewInstall,
	resolveInstallOrder,
	validateBundleApply,
} from '@maxstack/features/bundle'
import { bundleChoices } from '../lib/choices.ts'
import { generateProject } from '../lib/generate.ts'
import { loadProject, saveConfig } from '../lib/project.ts'
import {
	echoInvocation,
	type Interaction,
	nonInteractive,
} from '../lib/prompt.ts'

export interface AddOptions {
	/** Show the spec diff the install would produce; write nothing. */
	dryRun?: boolean
}

/**
 * Render the catalog.
 *
 * Generated from `describeCatalog()`, never a hand-maintained list — a catalog
 * blurb that drifts from the bundle it describes is worse than no blurb, because
 * it is believed.
 */
export function renderCatalog(entries: BundleSummary[]): string {
	const width = Math.max(...entries.map((e) => e.slug.length))
	const lines = entries.map((entry) => {
		const marks: string[] = []
		if (entry.installed) {
			marks.push(
				entry.installed.upgradeTo
					? `installed ${entry.installed.version} → ${entry.installed.upgradeTo} available`
					: `installed ${entry.installed.version}`,
			)
		}
		if (entry.requires.length) marks.push(`needs ${entry.requires.join(' + ')}`)
		if (entry.entitlement) marks.push(`gated by "${entry.entitlement}"`)
		// One line each: the first sentence of the description is written to stand
		// alone, and a picker that prints six lines per module is a picker nobody
		// reads to the bottom of.
		const blurb = `${entry.description.split('. ')[0] ?? entry.description}.`
		return (
			`  ${entry.slug.padEnd(width)}  ${entry.title}\n` +
			`  ${' '.repeat(width)}  ${blurb}` +
			(marks.length ? `\n  ${' '.repeat(width)}  (${marks.join(' · ')})` : '')
		)
	})
	return lines.join('\n\n')
}

/**
 * `maxstack add` with no bundle — browse the catalog.
 *
 * Annotated with what this project already has when run inside one, and usable
 * outside a project too: "what could I add" is a question people ask before
 * they have somewhere to add it to.
 */
export async function catalogCommand(
	dir: string | undefined,
	io: Interaction = nonInteractive,
): Promise<void> {
	let installed: InstalledBundle[] = []
	let inProject = false
	try {
		installed = (await loadProject(dir ?? '.')).config.bundles
		inProject = true
	} catch {
		// Not in a project. Still worth answering.
	}
	const entries = describeCatalog(installed)
	console.log(`\n  ${entries.length} installable modules\n`)
	console.log(renderCatalog(entries))

	// At a terminal inside a project, the catalog is a menu rather than a
	// reference (#421): the next thing anyone does with this output is retype one
	// of the slugs in it. Outside a project there is nowhere to install to, so it
	// stays a reference and prints the usage instead.
	const choices = inProject ? bundleChoices(installed) : []
	if (io.prompter && choices.length > 0) {
		console.log()
		// The last row, and the only one that writes nothing. `maxstack add` with
		// no argument is documented as *browsing* the catalog, so a picker with no
		// way out would turn a read-only verb into one that always installs
		// something — the user came to look, and looking has to stay free.
		const slug = await io.prompter.select<string | null>('Install one?', [
			...choices,
			{ value: null, label: 'none', hint: 'just browsing' },
		])
		if (slug === null) {
			console.log()
			return
		}
		echoInvocation(['maxstack', 'add', slug])
		await addCommand(dir ?? '.', slug)
		return
	}

	console.log(
		'\n  maxstack add <slug>            install it (prerequisites resolved first)' +
			'\n  maxstack add <slug> --dry-run  preview the spec diff, write nothing\n',
	)
}

/** Render an install preview — the same shape `--dry-run` and `init` print. */
export function renderPreview(
	preview: ReturnType<typeof previewInstall>,
): string {
	if (preview.errors.length)
		return `  refused:\n${preview.errors.map((e) => `    - ${e}`).join('\n')}`
	if (preview.order.length === 0) return '  nothing to do — already installed.'
	const lines = [`  would install: ${preview.order.join(', ')}`]
	if (preview.pulledIn.length)
		lines.push(
			`  pulled in as prerequisites: ${preview.pulledIn.join(', ')}`,
			'  (asked, not assumed — pass them yourself to be explicit)',
		)
	lines.push('', '  spec diff:')
	for (const op of preview.ops)
		lines.push(`    ${op.op.padEnd(22)} ${op.summary}`)
	lines.push(
		'',
		`  totals: +${preview.totals.entities} entities · +${preview.totals.pages} pages · ` +
			`+${preview.totals.tables} tables · +${preview.totals.routes} routes`,
	)
	if (preview.diBindings.length)
		lines.push(
			`  DI bindings the composition root would owe: ${preview.diBindings.join(', ')}`,
		)
	return lines.join('\n')
}

export async function addCommand(
	dir: string | undefined,
	slug: string,
	opts: AddOptions = {},
): Promise<void> {
	if (!getBundle(slug)) {
		throw new Error(
			`unknown bundle "${slug}". Run "maxstack add" with no arguments to browse the catalog.`,
		)
	}

	const project = await loadProject(dir ?? '.')
	const installed = project.config.bundles.map((b) => b.slug)

	// Preview before install. Every other spec mutation in this
	// product is reviewable before it lands; a bundle install being the exception
	// would make the one mutation that adds several entities and pages at once
	// also the one nobody sees first.
	if (opts.dryRun) {
		const preview = previewInstall(await project.spec.load(), [slug], installed)
		console.log(`\n${renderPreview(preview)}\n`)
		console.log('  (dry run — nothing was written)\n')
		return
	}

	// Resolve the install order: prerequisites (not already installed) first,
	// then the requested bundle. Empty if everything is already present.
	const toInstall = resolveInstallOrder(slug, BUNDLES, installed)
	if (toInstall.length === 0) {
		console.log(`✔ "${slug}" (and its prerequisites) already installed.`)
		return
	}

	let spec = await project.spec.load()
	const nowInstalled = [...installed]
	const records: InstalledBundle[] = [...project.config.bundles]

	for (const bundle of toInstall) {
		const errors = validateBundleApply(spec, bundle, nowInstalled)
		if (errors.length) {
			throw new Error(
				`cannot install "${bundle.slug}":\n- ${errors.join('\n- ')}`,
			)
		}
		spec = applyBundle(spec, bundle)
		nowInstalled.push(bundle.slug)
		records.push({ slug: bundle.slug, version: bundle.version })
	}

	await project.spec.save(spec)
	await saveConfig(project.root, { ...project.config, bundles: records })

	// Regenerate so any new pages become route modules the app can navigate to.
	const { writes } = await generateProject(project)

	const added = toInstall.map((b) => b.slug)
	const entityCount = toInstall.reduce(
		(n, b) => n + b.runtime.entities.length,
		0,
	)
	const pageCount = toInstall.reduce((n, b) => n + b.runtime.pages.length, 0)
	const bindings = [
		...new Set(toInstall.flatMap((b) => b.runtime.diBindings ?? [])),
	]

	console.log(`✔ added ${added.join(', ')}`)
	console.log(
		`  spec: +${entityCount} entities · +${pageCount} pages · ` +
			`${writes.length} route writes`,
	)
	if (bindings.length) {
		console.log(
			`  DI bindings the app must provide at the composition root: ${bindings.join(', ')}`,
		)
	}
	const gated = toInstall.filter((b) => b.entitlement)
	for (const b of gated) {
		console.log(
			`  ⚠ "${b.slug}" is gated by the "${b.entitlement}" entitlement — its ` +
				'features activate at runtime only for subjects whose plan grants it ' +
				'(add the "billing" bundle to enforce with hasEntitlement).',
		)
	}
	console.log(
		`  run "maxstack dev" to run the app (seeds apply on first boot).`,
	)
}
