/**
 * `landOp` — the shared "apply → (accept) → (gen)" pipeline behind the human
 * write verbs (`op`, `add-entity`, `add-field`). It exists so the one-command
 * happy path is one code path, not three: validate the op, land it,
 * optionally auto-accept the row it added, and optionally regenerate the app
 * tree — collapsing the real `op → workbench Accept → gen` loop into a single
 * trusted-solo invocation.
 *
 * Accept is expressed the honest way: a follow-up `provenance.review` op with
 * `cascade`, the exact same op the workbench emits. It lands in the op log and
 * is diffable — no out-of-band provenance mutation. On an op whose row is
 * already `manual()` (accepted), the cascade is a no-op, so `--accept` is
 * always safe to pass.
 */

import {
	applyOp,
	type OpActor,
	type OpId,
	type ReviewTarget,
	type SpecOp,
	type SpecSystem,
	validateOp,
} from '@maxstack/spec'
import { generateProject, isRegenStable } from './generate.ts'
import type { OpOrigin } from './origin.ts'
import type { Project } from './project.ts'

export interface LandOptions {
	/** Auto-accept the row the op added (a cascading `provenance.review`). */
	accept?: boolean
	/** Regenerate the app tree after landing (and accepting). */
	gen?: boolean
	/**
	 * Who authored the op. Defaults to `'human'`; callers resolve
	 * the real value with `resolveOrigin` so an agent driving the CLI doesn't
	 * log its work as hand-authored.
	 */
	origin?: OpOrigin
	/**
	 * *Which* author — resolved by `resolveActor`. Defaults to the
	 * bare `cli` surface with this write path's id, so a caller that has not been
	 * updated still lands attributed rather than lands unattributed: the
	 * distinction #200 protects is between "we recorded what we knew" and "we
	 * recorded nothing", not between complete and partial records.
	 */
	actor?: OpActor
}

/**
 * The `provenance.review` target for a structural add op — the row an
 * `--accept` should flip. `null` for ops that add no reviewable row (the
 * `prd.*` ops live in a layer the review-target kinds don't cover, and
 * `provenance.review` itself is already a decision).
 */
export function reviewTargetForOp(op: SpecOp): ReviewTarget | null {
	switch (op.op) {
		case 'data.addEntity':
			return { kind: 'entity', id: op.args.entity.id }
		case 'data.addField':
			return { kind: 'field', id: op.args.field.id, parentId: op.args.entityId }
		case 'page.addPage':
			return { kind: 'page', id: op.args.page.id }
		case 'page.addBlock':
			return { kind: 'block', id: op.args.block.id, parentId: op.args.pageId }
		case 'pricing.addTier':
			return { kind: 'tier', id: op.args.tier.id }
		default:
			return null
	}
}

/** Validate `op` against `spec`, throwing a readable rejection on failure. */
function assertValid(spec: SpecSystem, op: SpecOp): void {
	const errors = validateOp(spec, op)
	if (errors.length) {
		throw new Error(`op "${op.op}" rejected:\n- ${errors.join('\n- ')}`)
	}
}

function nextOpId(spec: SpecSystem): OpId {
	return `op-cli-${spec.opLog.length + 1}` as OpId
}

const today = (): string => new Date().toISOString().slice(0, 10)

export interface LandResult {
	spec: SpecSystem
	/** True when an accept cascade was applied (i.e. the row wasn't already settled). */
	accepted: boolean
	/** The gen summary, when `gen` was requested. */
	gen?: Awaited<ReturnType<typeof generateProject>>
}

/**
 * Apply one op to `spec` (already validated against it), optionally following
 * with the cascading `provenance.review` an `--accept` asks for. Returns the
 * new spec and whether an accept cascade was logged. Shared by `landOp` and
 * `landOps` so single- and multi-op lands take the exact same path.
 */
function applyOne(
	spec: SpecSystem,
	op: SpecOp,
	accept: boolean,
	origin: OpOrigin,
	actor: OpActor,
): { spec: SpecSystem; accepted: boolean } {
	assertValid(spec, op)
	let next = applyOp(spec, op, {
		id: nextOpId(spec),
		origin,
		appliedAt: today(),
		actor,
	})

	if (accept) {
		const target = reviewTargetForOp(op)
		if (target) {
			const reviewOp: SpecOp = {
				op: 'provenance.review',
				args: { target, action: 'accept', cascade: true },
			}
			// The just-applied row exists in `next`; validating against it proves the
			// target resolves before we log the decision.
			assertValid(next, reviewOp)
			// Same author AND same actor as the op it settles — the accept is part
			// of the same invocation, not a separate human review, and the trail
			// has to say so rather than let a `--accept` read as a review that
			// somebody performed.
			next = applyOp(next, reviewOp, {
				id: nextOpId(next),
				origin,
				appliedAt: today(),
				actor,
			})
			return { spec: next, accepted: true }
		}
	}
	return { spec: next, accepted: false }
}

/**
 * Apply `op` to the project's spec, optionally auto-accept and regenerate.
 * Persists the spec once (after any accept) so the op log stays consistent.
 */
export async function landOp(
	project: Project,
	op: SpecOp,
	opts: LandOptions = {},
): Promise<LandResult> {
	return landOps(project, [op], opts)
}

/**
 * Land an ordered batch of ops in one shot — each validated against the spec
 * produced by the previous, so a later op can reference a row an earlier one
 * added (the `--with-page` sugar lands `data.addEntity` then
 * `page.addPage`). Persists once after the whole batch and regenerates at
 * most once, so a two-op land is a single save + single gen, not two of
 * each.
 */
export async function landOps(
	project: Project,
	ops: SpecOp[],
	opts: LandOptions = {},
): Promise<LandResult> {
	let next = await project.spec.load()
	let accepted = false
	const origin = opts.origin ?? 'human'
	const actor: OpActor = opts.actor ?? { surface: 'cli', path: 'cli-land-op' }
	for (const op of ops) {
		const step = applyOne(next, op, opts.accept ?? false, origin, actor)
		next = step.spec
		accepted = accepted || step.accepted
	}

	await project.spec.save(next)

	if (opts.gen) {
		const gen = await generateProject(project)
		return { spec: next, accepted, gen }
	}
	return { spec: next, accepted }
}

/** A one-line summary of a land result, for the CLI success message. */
export function landSummary(result: LandResult): string {
	const s = result.spec
	const lines = [
		`  spec now: ${s.data.entities.length} entities · ${s.pages.pages.length} pages · ` +
			`ledger ${s.ledger.length} · op-log ${s.opLog.length}`,
	]
	if (result.accepted) lines.push('  accepted (grounded — cleared the review queue)')
	if (result.gen) {
		lines.push(
			`  generated ${result.gen.writes.length} route writes · ` +
				`${result.gen.artifacts.length} artifacts` +
				(isRegenStable(result.gen.writes) ? ' (regen stable)' : ''),
		)
	} else {
		lines.push('  run "maxstack gen" to regenerate the app.')
	}
	return lines.join('\n')
}
