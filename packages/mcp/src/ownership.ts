/**
 * **The current derivation** — what the generator would emit for
 * every page in a spec, right now, without writing any of it.
 *
 * The input the ownership drift report needs. Comparing a file you own against
 * what the platform would produce today requires having what it would produce
 * today, and the only honest way to get that is to run the same emitter
 * regeneration runs — anything else is a second derivation that can disagree
 * with the first.
 *
 * It lives here, next to `slotInventory` and `pageDescriptor`, for the reason
 * that fold gives: **one derivation, three surfaces.** `maxstack drift`, the
 * `ownership_drift` MCP tool and the workbench pane all call this, so a human
 * and an agent cannot be told different things about the same file. Putting it
 * in either app would have meant the other app reimplementing it.
 *
 * ## Every family the generator emits, not just pages
 *
 * The page layer was the whole ladder when this was written, so folding only
 * `spec.pages.pages` was complete. It is not any more: schedules, sources
 *, imports and live channels each emit a **framework-owned
 * registry** that a maintainer can eject, and an ejected file with no target in
 * here reads as `underived` — a status whose explanation used to assert the file
 * came from a deleted page. Deriving the registries is what makes an ejected one
 * comparable at all, and what leaves `underived` meaning what it says.
 *
 * What is deliberately **not** derived here is the write-once half of each seam
 * — a handler, a refiner, a parser, a bespoke surface. Those are stubbed once
 * and never derived again, so there is no "current derivation" to be behind, and
 * synthesizing one out of the stub would report the feature working as if it
 * were rot. They are `user`-owned, so the drift report answers `authored`; if
 * one is ejected it answers `underived`, and now says so in the terms of the
 * seam it came from.
 *
 * Nothing here touches a filesystem. Drift itself — which files are yours, and
 * what is in them — is a disk fact the caller supplies.
 */

import {
	emitImportRegistry,
	emitLiveRegistry,
	emitResourcePage,
	emitScheduleRegistry,
	emitSourceRegistry,
	type ImporterDescriptor,
	importerFilePaths,
	type LiveDescriptor,
	liveFilePaths,
	pageFilePaths,
	pageModuleKey,
	type RegenTarget,
	type ScheduleDescriptor,
	type SeamFamily,
	type SourceDescriptor,
	scheduleFilePaths,
	sourceFilePaths,
} from '@maxstack/core/ownership'
import {
	describeRecurrence,
	describeRunAs,
	listImporters,
	listLiveSubscriptions,
	listSchedules,
	listSources,
	originOf,
	type SpecSystem,
} from '@maxstack/spec'
import { pageDescriptors } from './generators.ts'

/**
 * Descriptors for every declared schedule — the same projection `generateSchedules`
 * is driven with. Reads **every** declared schedule rather than only the active
 * ones: `activeSchedules` is a runtime filter, and a derivation that depended on
 * it would report drift the moment somebody paused a job.
 */
export function scheduleDescriptors(spec: SpecSystem): ScheduleDescriptor[] {
	return listSchedules(spec).map((schedule) => ({
		key: schedule.key,
		description: schedule.description,
		runAs: describeRunAs(schedule.runAs),
		recurrence: describeRecurrence(schedule.recurrence, schedule.timezone),
	}))
}

/** Descriptors for every declared source. */
export function sourceDescriptors(spec: SpecSystem): SourceDescriptor[] {
	return listSources(spec).map((source) => ({
		key: source.key,
		description: source.description,
		mode: source.mode,
		endpoint: originOf(source.request.url) ?? source.request.url,
		refine: source.refine === true,
	}))
}

/** Descriptors for every declared importer. */
export function importerDescriptors(spec: SpecSystem): ImporterDescriptor[] {
	return listImporters(spec).map((importer) => ({
		key: importer.key,
		description: importer.description,
		format: importer.format,
		resource: importer.entityId.replace(/^e-/, ''),
		...(importer.parserSlot ? { parserSlot: importer.parserSlot } : {}),
	}))
}

/** Descriptors for every declared live channel. */
export function liveDescriptors(spec: SpecSystem): LiveDescriptor[] {
	return listLiveSubscriptions(spec).map((sub) => {
		// Field *names*, not ids — the descriptor feeds a generated props type. An
		// id with no field (soft-rejected after the channel was declared) is
		// dropped rather than emitted as a dangling name.
		const entity = spec.data.entities.find((e) => e.id === sub.entityId)
		const byId = new Map(entity?.fields.map((f) => [f.id, f.name]) ?? [])
		return {
			key: sub.key,
			description: sub.description,
			kind: sub.kind,
			resource: sub.entityId.replace(/^e-/, ''),
			bound:
				sub.scope.kind === 'filtered'
					? `rows matching ${byId.get(sub.scope.fieldId) ?? sub.scope.fieldId}`
					: sub.scope.kind === 'row'
						? 'one row'
						: 'every row',
			fields: sub.fields
				.map((id) => byId.get(id))
				.filter((n): n is string => n !== undefined),
			slot: sub.slot === true,
		}
	})
}

/**
 * What the generator would emit for every page in `spec`, keyed by the page's
 * route module — the same key `generateResourcePage` writes the manifest entry
 * under, which is what lets a drift report be matched against it. The slot file
 * stays keyed by resource, as it is on disk.
 */
function pageTargets(spec: SpecSystem): RegenTarget[] {
	return pageDescriptors(spec.pages.pages).map((descriptor) => {
		const key = pageModuleKey(descriptor)
		return {
			id: key,
			file: pageFilePaths(key).routeFile,
			routePath: descriptor.routePath,
			...(descriptor.slots.length > 0
				? { slotFile: pageFilePaths(descriptor.resource).slotFile }
				: {}),
			nextContent: emitResourcePage(descriptor),
		}
	})
}

/**
 * Every non-page seam, with **which declarations actually open a slot** — the
 * one place those filters live.
 *
 * `refine`, `format: 'custom'` and `slot` decide three separate things at once:
 * what the generator emits, what the current derivation is for the drift report,
 * and — since #355 — what regeneration prunes when the last declaration goes
 * away. Three copies of a filter is three chances for the pruner to delete a
 * registry the emitter would have written, so there is one copy and everything
 * reads it.
 *
 * The `slot`-less half of each family is deliberately absent: a source that maps
 * cleanly, a csv importer, a live channel with no bespoke surface. Their
 * declaration *is* the implementation and no file exists to keep or remove.
 */
export function seamFamilies(spec: SpecSystem): SeamFamilyTarget[] {
	const refining = sourceDescriptors(spec).filter((d) => d.refine)
	const custom = importerDescriptors(spec).filter((d) => d.format === 'custom')
	const slotted = liveDescriptors(spec).filter((d) => d.slot)
	const schedules = scheduleDescriptors(spec)

	const family = (
		partial: Omit<SeamFamilyTarget, 'liveKeys' | 'registryContent'>,
		descriptors: readonly { key: string }[],
		emit: () => string,
	): SeamFamilyTarget => ({
		...partial,
		liveKeys: descriptors.map((d) => d.key),
		// `undefined`, not an empty registry: the absence rule is that a project
		// declaring none of these never had the file at all.
		registryContent: descriptors.length > 0 ? emit() : undefined,
	})

	return [
		family(
			{
				noun: 'schedule',
				stub: 'handler',
				registryId: 'schedules:registry',
				stubPrefix: 'schedule:',
				registryFile: scheduleFilePaths('_').registryFile,
			},
			schedules,
			() => emitScheduleRegistry(schedules),
		),
		family(
			{
				noun: 'source',
				stub: 'refiner',
				registryId: 'sources:registry',
				stubPrefix: 'source:',
				registryFile: sourceFilePaths('_').registryFile,
			},
			refining,
			() => emitSourceRegistry(refining),
		),
		family(
			{
				noun: 'importer',
				stub: 'parser',
				registryId: 'imports:registry',
				stubPrefix: 'import:',
				registryFile: importerFilePaths('_').registryFile,
			},
			custom,
			() => emitImportRegistry(custom),
		),
		family(
			{
				noun: 'live channel',
				stub: 'surface',
				registryId: 'live:registry',
				stubPrefix: 'live:',
				registryFile: liveFilePaths('_').registryFile,
			},
			slotted,
			() => emitLiveRegistry(slotted),
		),
	]
}

/** A {@link SeamFamily} plus what its registry would contain right now. */
export interface SeamFamilyTarget extends SeamFamily {
	/** Where the framework-owned registry lives, relative to the app root. */
	registryFile: string
	/**
	 * What the registry would contain today, or `undefined` when the family
	 * declares nothing that opens a slot and the generator would therefore emit
	 * no registry at all.
	 */
	registryContent: string | undefined
}

/**
 * The framework-owned registry each non-page seam emits, when it emits one.
 *
 * The absence rule is the generators' own and it is load-bearing here: a project
 * with no declared schedules emits no registry, so there is no target, and an
 * ejected registry in that project is genuinely underived rather than in-sync
 * with an empty file. Emitting an empty registry as the "current derivation"
 * would report every such file as drifted by its entire contents.
 */
function registryTargets(spec: SpecSystem): RegenTarget[] {
	const targets: RegenTarget[] = []
	for (const family of seamFamilies(spec)) {
		if (family.registryContent === undefined) continue
		targets.push({
			id: family.registryId,
			file: family.registryFile,
			routePath: '',
			nextContent: family.registryContent,
		})
	}
	return targets
}

/**
 * What the generator would emit today, across every family it emits: one target
 * per page, plus the framework-owned registry of each declared seam.
 */
export function regenTargets(spec: SpecSystem): RegenTarget[] {
	return [...pageTargets(spec), ...registryTargets(spec)]
}
