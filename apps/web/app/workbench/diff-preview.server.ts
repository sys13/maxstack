/**
 * Before/after diff preview (part of epic #8's Review stage).
 *
 * The existing live preview (`preview.server.ts`) renders one page: the spec
 * as it is. For *review* the missing verb is diff — render the spec as-is
 * beside the spec-if-this-pending-change-is-accepted, so "review a change"
 * stops being abstract JSON ("addBlock into pg-checkout") and becomes "here's
 * what checkout looks like before/after."
 *
 * Deliberately reuses the existing machinery rather than building a second
 * rendering pipeline:
 *   - the hypothetical "if accepted" spec is produced with the SAME
 *     `applyOp` (`@maxstack/spec`) the Land step (`land.server.ts`) uses to
 *     actually land a candidate — `applyOp` already `structuredClone`s the
 *     input system internally, so the original spec is never mutated, and
 *     validation still runs (an op that wouldn't be landable throws here too,
 *     surfaced as `unavailableReason` instead of a hard error);
 *   - both the "before" and "after" specs are rendered through the same
 *     `platform.generators.run('page', …)` in-memory-FS path
 *     (`@maxstack/mcp`'s `createMemFs`, see `generators.ts`'s `pageGenerator`)
 *     and the same `renderGeneratedPage` (`preview.server.ts`) the single-page
 *     preview pane already uses — nothing here evaluates a module twice with
 *     different logic, it's the same renderer fed two different specs.
 *
 * Only `kind: 'spec-op', via: 'apply-op'` candidates carry a typed `SpecOp` to
 * apply — the same gate `land.server.ts`'s `landable` uses. Everything else
 * (`slot-fill` / `eject` / `off-surface` / `regen-diff`) has no typed op, so
 * there is nothing to compute a hypothetical spec from; this reports why
 * instead of guessing.
 */

import type { PlatformContext } from '@maxstack/mcp'
import {
	applyOp,
	type PageSpec,
	type ReviewTarget,
	type SpecOp,
	type SpecSystem,
} from '@maxstack/spec'
import { getPlatform } from '~/sprout.server'
import { deriveIssues } from './issues.server'
import { allLandedKeys } from './land.server'
import { type RenderedPreview, renderGeneratedPage } from './preview.server'
import { buildReviewQueue, type QueueItem } from './review-queue'

/** The rendered before/after pair for one pending change, plus the target
 *  coordinate both renders are keyed on (for highlighting in the pane). */
export interface DiffPreviewData {
	key: string
	title: string
	/** The coordinate this change is filed against — highlighted in both
	 *  renders (see `resolvePageId`'s note on the granularity available). */
	targets: ReviewTarget[]
	pageId: string | null
	/** `null` when the page doesn't exist yet in the current spec (e.g. the
	 *  candidate itself is `page.addPage`) — a legitimate "nothing here yet"
	 *  state, not a render error. */
	before: RenderedPreview | null
	after: RenderedPreview | null
	/** Set when no diff could be computed at all (no typed op, no resolvable
	 *  page, or the op doesn't validate against the current spec) — the pane
	 *  shows this instead of two empty boxes. */
	unavailableReason: string | null
}

/**
 * Which page (if any) a candidate op's before/after actually renders — the
 * coordinate this diff preview can show. The generator only emits DOM at
 * page granularity (a `data-resource` section, no per-field/per-block ids —
 * see `emitResourcePage`), so "highlight the target" resolves to "render the
 * page the target lives on," the finest grain the generator affords.
 */
function resolvePageId(
	spec: SpecSystem,
	op: SpecOp,
	targets: readonly ReviewTarget[],
): string | null {
	if (op.op === 'page.addPage') return op.args.page.id
	if (op.op === 'page.addBlock') return op.args.pageId
	for (const target of targets) {
		if (target.kind === 'page') return target.id
		if (target.kind === 'block' && target.parentId) return target.parentId
		if (target.kind === 'entity') {
			const page = spec.pages.pages.find(
				(p: PageSpec) => p.entityId === target.id,
			)
			if (page) return page.id
		}
	}
	return null
}

/** A fixed, non-persisted `ApplyMeta` for the hypothetical apply — never
 *  written to the real op log (`applyOp`'s result here is only ever rendered,
 *  never passed to `platform.spec.save`). */
const PREVIEW_APPLY_META = {
	id: 'op-preview' as const,
	origin: 'human' as const,
	appliedAt: '1970-01-01T00:00:00.000Z',
	// A preview is a read dressed as an apply. The `path` names it as such so that
	// if one ever *did* reach disk, the entry would identify itself rather than
	// pass as a real workbench write — and `write-path.invariant.test.ts` asserts
	// it never does.
	actor: { surface: 'web' as const, path: 'web-diff-preview' },
}

/** Render one spec's page (or report why it can't) — shared by the before and
 *  after branches so they run through the exact same path. */
async function renderPage(
	platform: PlatformContext,
	spec: SpecSystem,
	pageId: string,
): Promise<RenderedPreview | null> {
	if (!spec.pages.pages.some((p) => p.id === pageId)) return null
	const result = await platform.generators.run('page', spec, { pageId })
	return renderGeneratedPage(result.artifacts)
}

/**
 * Apply a candidate's typed op to a *clone* of the spec — the "if accepted"
 * hypothetical, never persisted. Returns `null` (with a reason) rather than
 * throwing when the op doesn't validate (e.g. it was already landed since the
 * queue was last derived), so a stale click degrades to a message instead of
 * a 500.
 */
export function computeHypotheticalSpec(
	spec: SpecSystem,
	op: SpecOp,
): { spec: SpecSystem | null; error: string | null } {
	try {
		return { spec: applyOp(spec, op, PREVIEW_APPLY_META), error: null }
	} catch (err) {
		return {
			spec: null,
			error: err instanceof Error ? err.message : String(err),
		}
	}
}

/** Look up one queue item by its stable key — same fold `review-queue.server`
 *  uses for the loader, re-derived fresh (never trusts a client-submitted
 *  candidate) so a stale link can't preview something no longer proposed. */
async function findQueueItem(key: string): Promise<QueueItem | null> {
	const issues = await deriveIssues()
	const landed = await allLandedKeys()
	const model = buildReviewQueue(issues, 'product', landed)
	return model.items.find((item) => item.key === key) ?? null
}

/**
 * The diff preview for one review-queue item: the spec as it is, and the spec
 * if this item's headline candidate is accepted, both rendered through the
 * existing preview machinery. `null` when the key doesn't resolve to a queue
 * item at all (stale link).
 */
export async function loadDiffPreview(
	key: string,
	platform: PlatformContext = getPlatform(),
): Promise<DiffPreviewData | null> {
	const item = await findQueueItem(key)
	if (!item) return null

	const base: Omit<
		DiffPreviewData,
		'pageId' | 'before' | 'after' | 'unavailableReason'
	> = {
		key: item.key,
		title: item.title,
		targets: item.targets,
	}

	if (
		item.headline?.change.kind !== 'spec-op' ||
		item.headline.change.via !== 'apply-op'
	) {
		return {
			...base,
			pageId: null,
			before: null,
			after: null,
			unavailableReason:
				'no landable spec-op candidate yet (only spec-op/apply-op changes can be diffed)',
		}
	}
	const { op } = item.headline.change

	const spec = await platform.spec.load()
	const pageId = resolvePageId(spec, op, item.targets)
	if (!pageId) {
		return {
			...base,
			pageId: null,
			before: null,
			after: null,
			unavailableReason:
				"this change doesn't resolve to a page the live preview can render",
		}
	}

	const { spec: hypothetical, error } = computeHypotheticalSpec(spec, op)
	if (!hypothetical) {
		return {
			...base,
			pageId,
			before: await renderPage(platform, spec, pageId),
			after: null,
			unavailableReason: error ?? 'could not apply the candidate change',
		}
	}

	const [before, after] = await Promise.all([
		renderPage(platform, spec, pageId),
		renderPage(platform, hypothetical, pageId),
	])

	return { ...base, pageId, before, after, unavailableReason: null }
}
