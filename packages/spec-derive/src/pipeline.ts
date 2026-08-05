/**
 * Spec → generator inputs. Derives the {@link PageDescriptor}s the ownership
 * generator consumes from a {@link SpecSystem}'s page layer — the first hop of
 * the `maxstack eval` pipeline (spec → generate → agent loop → validate).
 *
 * Two page-layer conventions are read here:
 *   - the **resource** is the page's `entityId` with its `e-` prefix stripped
 *     (falling back to a slug of the page name for entity-less pages);
 *   - a block whose `type` is `slot:<name>` marks a **cross-file extension
 *     slot** — the generated page exposes a `<Slot name="<name>">`, and the
 *     user owns the matching `*.slots.tsx` render function.
 */

import type {
	ImporterDescriptor,
	LiveDescriptor,
	PageDescriptor,
	ScheduleDescriptor,
	SourceDescriptor,
} from '@maxstack/core/ownership'
import { blockSlotsForResource } from '@maxstack/core/ownership'
import {
	describeRecurrence,
	describeRunAs,
	getAcceptedOrAll,
	listImporters,
	listLiveSubscriptions,
	listSchedules,
	listSources,
	originOf,
	type PageSpec,
	type SpecSystem,
} from '@maxstack/spec'

const SLOT_PREFIX = 'slot:'

/**
 * The prefix a benchmark change uses to name the **schedule handler** seam
 * rather than a page slot: `schedule:invoice.recurring`. Both are slot fills
 * from the maintainer's side (the platform said where the code goes and
 * promised not to overwrite it); they differ only in which file that is.
 */
export const SCHEDULE_SLOT_PREFIX = 'schedule:'

/**
 * The prefix a benchmark change uses to name the **source refiner** seam
 *: `source:inbox.sync`. A third seam answering to `slot-fill`, and
 * the same bargain as the other two from the maintainer's side — the platform
 * said where the code goes and promised not to overwrite it.
 */
export const SOURCE_SLOT_PREFIX = 'source:'

/**
 * The prefix a benchmark change uses to name the **import parser** seam
 *: `import:anki.apkg`. A fourth seam answering to `slot-fill`, on
 * the same bargain as the other three — the platform said where the code goes
 * and promised not to overwrite it.
 */
export const IMPORT_SLOT_PREFIX = 'import:'

/**
 * The prefix a benchmark change uses to name the **bespoke live surface** seam
 *: `live:task-board`. A fifth seam answering to `slot-fill`, on the
 * same bargain as the other four — the platform said where the code goes and
 * promised not to overwrite it.
 */
export const LIVE_SLOT_PREFIX = 'live:'

/** The generator resource id for a page (`e-task` → `task`). */
export function resourceOf(page: PageSpec): string {
	if (page.entityId) return page.entityId.replace(/^e-/, '')
	return page.name
		.trim()
		.toLowerCase()
		.replace(/[^a-z0-9]+/g, '-')
		.replace(/^-+|-+$/g, '')
}

/** The slot names a page declares, in `blocks` order. */
export function slotsOf(page: PageSpec): string[] {
	return page.blocks
		.filter((b) => b.type.startsWith(SLOT_PREFIX))
		.map((b) => b.type.slice(SLOT_PREFIX.length))
}

/** Descriptor for one page. */
export function pageToDescriptor(page: PageSpec): PageDescriptor {
	return {
		resource: resourceOf(page),
		title: page.name,
		routePath: page.route,
		slots: slotsOf(page),
	}
}

/**
 * The **block-level** slot ids available on a resource — every
 * derived slot a benchmark's `slot-fill` change could legitimately name.
 *
 * This is the harness's own fold, deliberately separate from `@maxstack/mcp`'s
 * `slotInventory` (the same relationship `pageToDescriptor` has with
 * `pageDescriptor`): the harness measures the platform and must not measure it
 * through the platform's own discovery surface. `slots.agreement.test.ts` pins
 * the two to the same answer, exactly as issue #42's test pins the page-slot
 * derivation.
 *
 * A slot-fill against an id NOT in this set does not land — which is what makes
 * a corpus reclassification from `eject` to `slot-fill` a *measurement* rather
 * than an assertion. Relabel an ask without shipping the seam and the harness
 * reports it as unlanded, and the expressibility number does not move.
 */
export function availableBlockSlots(
	spec: SpecSystem,
	resource: string,
): string[] {
	const page = spec.pages.pages.find((p) => resourceOf(p) === resource)
	if (!page) return []
	const table = getAcceptedOrAll(page.blocks).find((b) => b.type === 'table')
	const entity = spec.data.entities.find((e) => e.id === page.entityId)
	const fields =
		table?.fields && table.fields.length > 0
			? table.fields
			: (entity?.fields.map((f) => f.name) ?? [])
	return blockSlotsForResource(resource, fields).map((s) => s.id)
}

/** Descriptors for every page in a spec system, in declaration order. */
export function specToDescriptors(spec: SpecSystem): PageDescriptor[] {
	return spec.pages.pages.map(pageToDescriptor)
}

/**
 * Descriptors for every declared schedule — what the ownership
 * layer needs to emit the handler-slot seam.
 *
 * Deliberately reads **every** declared schedule rather than only the active
 * ones. `activeSchedules` is a *runtime* filter (accepted, unpaused); the
 * generated tree must not depend on it, or pausing a schedule would rewrite the
 * app and regeneration would stop being a function of the declaration. A paused
 * schedule keeps its handler file; it simply does not fire.
 */
export function specToScheduleDescriptors(
	spec: SpecSystem,
): ScheduleDescriptor[] {
	return listSchedules(spec).map((schedule) => ({
		key: schedule.key,
		description: schedule.description,
		runAs: describeRunAs(schedule.runAs),
		recurrence: describeRecurrence(schedule.recurrence, schedule.timezone),
	}))
}

/**
 * Descriptors for every declared source — what the ownership layer
 * needs to emit the refiner seam.
 *
 * Reads **every** declared source rather than only the active ones, for the
 * reason {@link specToScheduleDescriptors} gives: `activeSources` is a *runtime*
 * filter, and if the generated tree depended on it, pausing an integration
 * would rewrite the app. A paused source keeps its refiner file; it simply does
 * not fetch.
 *
 * Nothing here reads a response or a job row. The descriptor is a projection of
 * the declaration, which is what makes "generation never makes a network call"
 * a structural property rather than a promise.
 */
/**
 * Descriptors for every declared importer — what the ownership
 * layer needs to emit the parser seam.
 *
 * Reads **every** declared importer rather than only the active ones, for the
 * reason {@link specToScheduleDescriptors} gives: `activeImporters` is a
 * *runtime* filter (accepted, unpaused), and if the generated tree depended on
 * it, pausing an importer would rewrite the app and regeneration would stop being
 * a function of the declaration. A paused importer keeps its parser file; it
 * simply refuses uploads.
 *
 * Nothing here reads a file. The descriptor is a projection of the declaration,
 * which is what makes "generation never reads an upload" structural rather than
 * a promise — pinned by `apps/maxstack/src/lib/import-determinism.test.ts`.
 */
export function specToImporterDescriptors(
	spec: SpecSystem,
): ImporterDescriptor[] {
	return listImporters(spec).map((importer) => ({
		key: importer.key,
		description: importer.description,
		format: importer.format,
		resource: importer.entityId.replace(/^e-/, ''),
		...(importer.parserSlot ? { parserSlot: importer.parserSlot } : {}),
	}))
}

/**
 * Descriptors for every declared live channel — what the ownership
 * layer needs to emit the bespoke-surface seam.
 *
 * Reads **every** declared subscription rather than only the active ones, for
 * the reason {@link specToScheduleDescriptors} gives: `activeLiveSubscriptions`
 * is a *runtime* filter (accepted, unpaused), and if the generated tree depended
 * on it, pausing a channel at 3am would rewrite the app and produce a
 * regeneration diff to review at exactly the wrong moment. A paused channel
 * keeps its surface file; it simply stops accepting connections, and the surface
 * polls instead.
 *
 * Nothing here reads a clock, a socket or a subscriber count. The descriptor is
 * a projection of the declaration, which is what makes "generation never opens a
 * connection" structural rather than a promise — pinned by
 * `apps/maxstack/src/lib/live-determinism.test.ts`.
 */
export function specToLiveDescriptors(spec: SpecSystem): LiveDescriptor[] {
	return listLiveSubscriptions(spec).map((sub) => {
		// Field *names*, not ids: the descriptor feeds a generated props type, and
		// `fld-task-title` is not an identifier. Resolving here rather than in the
		// ownership layer keeps that layer free of the spec's id vocabulary, which
		// is the same split every other descriptor makes. An id with no field
		// (soft-rejected after the channel was declared) is dropped rather than
		// emitted as a dangling name.
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

export function specToSourceDescriptors(spec: SpecSystem): SourceDescriptor[] {
	return listSources(spec).map((source) => ({
		key: source.key,
		description: source.description,
		mode: source.mode,
		// The origin, never the full URL: a declared query string is not a secret
		// (the validator refuses one that is), but it is noise in a file header.
		endpoint: originOf(source.request.url) ?? source.request.url,
		refine: source.refine === true,
	}))
}
