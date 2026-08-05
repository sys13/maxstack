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
	type RegenTarget,
	type ScheduleDescriptor,
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
import { pageDescriptor } from './generators.ts'

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

/** What the generator would emit for every page in `spec`, keyed by resource. */
function pageTargets(spec: SpecSystem): RegenTarget[] {
	return spec.pages.pages.map((page) => {
		const descriptor = pageDescriptor(page)
		const paths = pageFilePaths(descriptor.resource)
		return {
			id: descriptor.resource,
			file: paths.routeFile,
			routePath: descriptor.routePath,
			...(descriptor.slots.length > 0 ? { slotFile: paths.slotFile } : {}),
			nextContent: emitResourcePage(descriptor),
		}
	})
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

	const schedules = scheduleDescriptors(spec)
	if (schedules.length > 0) {
		targets.push({
			id: 'schedules:registry',
			file: scheduleFilePaths('_').registryFile,
			routePath: '',
			nextContent: emitScheduleRegistry(schedules),
		})
	}

	const refining = sourceDescriptors(spec).filter((d) => d.refine)
	if (refining.length > 0) {
		targets.push({
			id: 'sources:registry',
			file: sourceFilePaths('_').registryFile,
			routePath: '',
			nextContent: emitSourceRegistry(refining),
		})
	}

	const custom = importerDescriptors(spec).filter((d) => d.format === 'custom')
	if (custom.length > 0) {
		targets.push({
			id: 'imports:registry',
			file: importerFilePaths('_').registryFile,
			routePath: '',
			nextContent: emitImportRegistry(custom),
		})
	}

	const slotted = liveDescriptors(spec).filter((d) => d.slot)
	if (slotted.length > 0) {
		targets.push({
			id: 'live:registry',
			file: liveFilePaths('_').registryFile,
			routePath: '',
			nextContent: emitLiveRegistry(slotted),
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
