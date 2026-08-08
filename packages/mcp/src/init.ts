/**
 * `init` — the agent's first call, and its batch write path.
 *
 * ## Why a tool, and not "the agent should call the other eight"
 *
 * An agent that has just connected knows the tool *names* and nothing else. To
 * learn what this project is and what it is allowed to do here it has to fish:
 * `query_spec` across summary, data, requirements, ops, slots and api, then
 * `browse_catalog`, then `review_queue`. Eight calls before it does anything —
 * and that is the good case, the one where it already knows those sections
 * exist. The likelier case is it reads `summary`, decides it has enough, and
 * starts proposing ops having never learned that slots exist or that the bundle
 * it is about to hand-build is one install away.
 *
 * This is the same argument `steering.ts` makes about descriptions vs results,
 * one step earlier: agents stop early, so the complete picture has to be the
 * *cheapest* thing to fetch. Nothing here is computed that the other tools
 * cannot already answer — the point is precisely that it is one call.
 *
 * ## Why the same tool takes `ops`
 *
 * `propose_spec_change` / `apply_spec_change` take exactly one op. Six entities
 * at eight fields each is fifty round trips, each paying validation, a
 * spec-shaped diff, an app-shaped effect and a steering envelope. That is the
 * real tax on an opening move, and it is invisible because each call is fast.
 *
 * Two rules make a batch safe rather than merely quick:
 *
 *   - **All-or-nothing.** Every op is validated against the spec *as the
 *     preceding ops would leave it*, so op 2 may depend on op 1, and the store
 *     is written exactly once, at the end. A half-applied batch leaves the spec
 *     in a state nobody designed and is strictly worse than fifty honest calls.
 *   - **One merged `effect`.** Fifty separate blast radiuses are unreadable, and
 *     unreadable is where the value of the batch would have been. The whole
 *     chain is folded into a single `blastRadius(before, after)` — the same fold
 *     `workbench {section:"blast-radius"}` runs over the pending queue.
 *
 * `apply` defaults to **false**. Applied rows land accepted with AI provenance;
 * a forty-op batch auto-accepting is exactly the volume the review queue exists
 * to slow down, so committing it is a thing the caller says out loud.
 *
 * ## What a batch reply leaves out
 *
 * The orientation payload is the right default for the *first* call and that
 * argument stands. It is the second call that pays for it: the documented flow
 * is deliberately two calls over the same batch — `apply` defaults to false, so
 * the caller consents to the effect before it lands — which re-sends the
 * expensive half at the one moment it is guaranteed to be redundant. The caller
 * read it a moment ago, and by construction nothing outside the batch moved in
 * between.
 *
 * So a call carrying `ops` answers about the batch. It keeps `batch` and its
 * merged `effect`, the derived counts in `project`, the requirements those ops
 * are meant to serve, and the small host-shaped keys; it drops the four
 * inventories (`data`, `pages`, `slots`, `api`), the `vocabulary` and the
 * `catalog`. Measured on an eight-op applied batch against the Taskly fixture:
 * 31,921 characters becomes 6,986, and the dry run that preceded it 25,561
 * becomes 6,583.
 *
 * This does not weaken the rule that an agent must never reason about a
 * pre-batch spec. Everything a batch reply *does* carry is computed from the
 * post-batch spec, and the part that moved is described better by `effect` — in
 * app shape, which is what the caller is deciding about — than by a re-sent
 * inventory the caller would have to diff by eye. What is left out is left out
 * *by name*, in `omitted` and in the headline, together with the one call that
 * brings it back: `init` with no `ops`.
 *
 * ## What is deliberately absent
 *
 * No `intent` / `description` field. No spec-op writes the product's intent, so
 * such a field would be accepted, echoed and dropped — a parameter that looks
 * like it did something is the failure this surface is built against. And no
 * scaffolding: `maxstack mcp` loads a project on disk at boot, so by the time
 * this tool can be called the project necessarily exists. `maxstack init` is the
 * human's entry point and stays the only one.
 */

import { apiContract } from '@maxstack/core'
import {
	applyOp,
	diffOp,
	effectiveDecisions,
	groupForBulkReview,
	type OpId,
	pendingProposals,
	type RiskContext,
	resolveTheme,
	SPEC_OP_VOCABULARY,
	type SpecOp,
	type SpecSystem,
	unauthoredPrdNotice,
	validateOpDryRun,
} from '@maxstack/spec'
import { type BlastRadius, blastRadius } from './blast-radius.ts'
import type { PlatformContext, UnavailableCheck } from './context.ts'
import { groundedEntityShapes } from './grounding.ts'
import { slotInventory } from './slots.ts'

// ===========================================================================
// Types
// ===========================================================================

/** One op's place in a batch — spec-shaped, since the app-shaped answer is merged. */
export interface BatchedOp {
	index: number
	op: string
	/** What the document would say. `null` when the op never validated. */
	diff: unknown
}

export interface InitBatch {
	/** How many ops the caller sent. */
	requested: number
	/** True only when every op validated AND `apply` was true AND the save ran. */
	applied: boolean
	/** The ops, in order, with their spec-shaped diffs. */
	ops: BatchedOp[]
	/**
	 * The whole chain read off the derived-surface inventory — what these ops do
	 * to the built application, together. `null` when the batch was refused.
	 */
	effect: BlastRadius | null
	/** The 0-based index of the op that refused the batch, or `null`. */
	failedAt: number | null
	/** Why it refused. Empty when nothing did. */
	errors: string[]
	headline: string
}

/** What a batch reply left out on purpose, and the call that returns it. */
export interface InitOmission {
	keys: string[]
	reason: string
	restoreWith: string
}

export interface InitReport {
	project: unknown
	requirements: unknown
	/** The orientation blocks: present on an orienting call, absent on a batch
	 * reply — where `omitted` names them rather than letting a missing key read
	 * as an empty one. */
	data?: unknown
	pages?: unknown
	slots?: unknown
	api?: unknown
	theme: unknown
	vocabulary?: unknown
	generators: unknown
	checks: unknown
	catalog?: unknown
	install: unknown
	pending: unknown
	unavailable: UnavailableCheck[]
	batch: InitBatch | null
	/** Null on an orienting call, which omits nothing. */
	omitted: InitOmission | null
	headline: string
}

// ===========================================================================
// The batch
// ===========================================================================

/** Coerce one loose `{op, args}` wire element into a `SpecOp`. */
function toSpecOp(raw: unknown): SpecOp {
	const o = (raw ?? {}) as Record<string, unknown>
	return { op: o.op, args: o.args } as SpecOp
}

/** Every id an op *declares* — any `id` key anywhere in its args, plus the
 * `blockId` a view op names, which is the one declaration not spelled `id`. */
function declaredIds(op: SpecOp): string[] {
	const found: string[] = []
	const walk = (node: unknown): void => {
		if (Array.isArray(node)) {
			for (const item of node) walk(item)
			return
		}
		if (typeof node !== 'object' || node === null) return
		for (const [key, value] of Object.entries(node)) {
			if ((key === 'id' || key === 'blockId') && typeof value === 'string')
				found.push(value)
			else walk(value)
		}
	}
	walk((op as { args?: unknown }).args)
	return found
}

/**
 * Issue #314 — when the op that refused the batch is refused *because of*
 * something an earlier op in the same batch declared, say which one.
 *
 * "Fix this one and resend" is only actionable when "this one" is where the
 * wrong arg lives. In an all-or-nothing batch a failure very often lands on the
 * first op that *reads* a declaration rather than the op that *wrote* it — the
 * board that needs a backing entity vs. the page that declared none. The whole
 * chain is in hand here, so the pointer costs nothing.
 *
 * The trigger is the *error text*, not the args: an id named by the refusal
 * itself is an id the refusal is about, whereas an id merely mentioned in the
 * args (every `entityId` on every field op) would attach a confident-sounding
 * pointer to failures that have nothing to do with the earlier op.
 */
function upstreamHint(ops: SpecOp[], index: number, errors: string[]): string {
	const failing = ops[index]
	if (!failing) return ''
	const text = errors.join(' ')
	const mine = new Set(declaredIds(failing))
	for (const [i, earlier] of ops.slice(0, index).entries())
		for (const id of declaredIds(earlier))
			if (!mine.has(id) && text.includes(id))
				return ` "${id}" was declared by op ${i} (${String(earlier.op)}) in this same batch — if op ${index}'s args look right, the arg to change is probably there.`
	return ''
}

/**
 * Validate the whole chain in memory, then commit it once — or refuse it whole.
 *
 * Each op is validated against the spec the *preceding* ops would produce, which
 * is what makes `data.addEntity` followed by eight `data.addField`s a legal
 * batch. The projection ids are fixed strings: nothing projected here is ever
 * saved, and spending real op ids on a dry run would make the counter jump for
 * batches that were only ever previewed.
 */
async function runBatch(
	ctx: PlatformContext,
	spec: SpecSystem,
	raw: unknown[],
	apply: boolean,
): Promise<{ batch: InitBatch; saved: SpecSystem | null }> {
	const ops = raw.map(toSpecOp)
	const rows: BatchedOp[] = []
	let projected = spec

	for (const [index, op] of ops.entries()) {
		const errors = validateOpDryRun(projected, op, ctx.origin)
		if (errors.length > 0) {
			return {
				saved: null,
				batch: {
					requested: ops.length,
					applied: false,
					ops: [...rows, { index, op: String(op.op), diff: null }],
					effect: null,
					failedAt: index,
					errors,
					headline: `REFUSED — nothing was written. Op ${index} (${String(op.op)}) is invalid: ${errors.join(' ')} A batch is all-or-nothing, so the ${index} op(s) before it did not land either.${upstreamHint(ops, index, errors)} Fix it and resend the whole list.`,
				},
			}
		}
		try {
			projected = applyOp(projected, op, {
				id: `op-init-projection-${index}` as OpId,
				origin: ctx.origin,
				appliedAt: ctx.now(),
				// Surface from the host, never assumed (issue #358) — see
				// `PlatformContext.surface`. The path stays this projection's own
				// name so a leaked entry is findable.
				actor: { ...ctx.actor, surface: ctx.surface, path: 'init-projection' },
			})
		} catch (e) {
			// The validator blessed it and the fold threw — that is a defect, not a
			// caller error, and the honest answer is to refuse the batch rather than
			// save a spec built from a projection that partially failed.
			return {
				saved: null,
				batch: {
					requested: ops.length,
					applied: false,
					ops: [...rows, { index, op: String(op.op), diff: null }],
					effect: null,
					failedAt: index,
					errors: [e instanceof Error ? e.message : String(e)],
					headline: `REFUSED — nothing was written. Op ${index} (${String(op.op)}) validated and then failed to apply, which is a maxstack defect: please report_defect with this payload.`,
				},
			}
		}
		rows.push({ index, op: String(op.op), diff: diffOp(op) })
	}

	// One fold over the whole chain, not one per op (see the header): the caller
	// is deciding about the batch, so the batch is what gets described.
	const effect = blastRadius(spec, projected)
	const moved =
		effect.added.length + effect.removed.length + effect.changed.length

	if (!apply) {
		return {
			saved: null,
			batch: {
				requested: ops.length,
				applied: false,
				ops: rows,
				effect,
				failedAt: null,
				errors: [],
				headline: `All ${ops.length} op(s) validate and NOTHING WAS WRITTEN — this was a proposal. Together they would change ${moved} surface(s) of the built application; read \`effect\` before you commit. Resend with {"apply": true} to land them (they land accepted, with AI provenance).`,
			},
		}
	}

	// Committed once, at the end, from the projection every op already passed
	// against — so the store never observes a partially-applied batch. The real
	// op ids are spent here and only here.
	let next = spec
	for (const op of ops) {
		next = applyOp(next, op, {
			id: ctx.nextOpId(),
			origin: ctx.origin,
			appliedAt: ctx.now(),
			actor: {
				...ctx.actor,
				surface: ctx.surface,
				path: ctx.writePath ?? 'mcp-init-batch',
			},
		})
	}
	await ctx.spec.save(next)
	return {
		saved: next,
		batch: {
			requested: ops.length,
			applied: true,
			ops: rows,
			effect: blastRadius(spec, next),
			failedAt: null,
			errors: [],
			headline: `Applied all ${ops.length} op(s) — they landed ACCEPTED with AI provenance and are live, not queued for review. They change ${moved} surface(s) of the built application; the code on disk does not reflect them until a generator runs.`,
		},
	}
}

// ===========================================================================
// The vocabulary
// ===========================================================================

/**
 * Every op this agent could reach for — by default without the arg schemas.
 *
 * Measured, not guessed: the full vocabulary is 112,974 characters (~28k tokens)
 * and 84% of that is the schemas. A tool that costs a fifth of a small context
 * window to call is a tool an agent learns to skip, which would defeat the
 * entire point of making the complete picture the cheapest thing to fetch.
 * Names, layers and summaries are ~4k and answer the question this tool exists
 * for — *what could I be using that I do not know exists?* — because you cannot
 * reach for an op you have never heard of, while you can always look up the
 * args of one you have.
 *
 * So the default is the discovery half, and the payload says in-band where the
 * other half is: `query_spec {section:"ops", ops:[…]}`, a handful at a time.
 *
 * `{vocabulary: "full"}` still exists, but it is NOT the fallback and the
 * default payload no longer offers it as one. Every schema at once is
 * ~113k characters, and the reference host does not charge for that — it
 * REFUSES it, so a call that recommends it is recommending a call that cannot
 * return. It survives only for a host with a context budget that can take it.
 */
function vocabularyFor(full: boolean): unknown {
	const all = Object.values(SPEC_OP_VOCABULARY)
	if (full) return all
	return {
		count: all.length,
		ops: all.map((v) => ({ name: v.name, layer: v.layer, summary: v.summary })),
		argSchemas:
			'OMITTED here to keep this call cheap. Get the ones you need with query_spec {section:"ops", ops:["page.addPage", ...]} — ask for a handful, not the whole vocabulary. That is the working path; do NOT reach for `init {vocabulary:"full"}` instead, which is every op\'s schema at once (~113k characters) and hosts refuse a payload that size. You never have to guess an arg shape.',
	}
}

// ===========================================================================
// The report
// ===========================================================================

/**
 * Issue #374 — said in-band, because a key that is not there is indistinguishable
 * from a key that came back empty, and "this project declares no pages" is
 * exactly the kind of wrong conclusion `unavailable` exists to prevent one layer
 * over. `unavailable` is for what this host *could not* answer; this is for what
 * the caller already has.
 */
const BATCH_OMISSION: InitOmission = {
	keys: ['data', 'pages', 'slots', 'api', 'vocabulary', 'catalog'],
	reason:
		'OMITTED, not empty. You are two calls into the same batch, so these are the blocks your orienting init already returned and nothing outside the batch has changed since. What the batch itself moved is in `batch.effect`, in app shape.',
	restoreWith:
		'init {} — the same call with no `ops` — returns the whole picture, computed after this batch.',
}

/**
 * Everything an agent needs before its first move, plus whatever opening batch
 * it sent. `trace.spec` is set by the caller when a batch committed.
 */
export async function initReport(
	ctx: PlatformContext,
	spec: SpecSystem,
	args: Record<string, unknown>,
): Promise<{ report: InitReport; saved: SpecSystem | null }> {
	const rawOps = Array.isArray(args.ops) ? args.ops : null
	const { batch, saved } = rawOps
		? await runBatch(ctx, spec, rawOps, args.apply === true)
		: { batch: null, saved: null }

	// Orientation always describes the spec as it stands AFTER the batch. An
	// agent that applied eight ops and then read a pre-batch inventory would be
	// reasoning about a project that no longer exists.
	const now = saved ?? spec
	// A batch reply answers about the batch; only an orienting call orients. See
	// the header — this is the second call in the documented dry-run/apply pair.
	const orienting = batch === null

	const unavailable: UnavailableCheck[] = []
	let catalog: unknown = null
	// Only an orienting call asks: a batch reply omits the catalog by name in
	// `omitted`, which is a different claim from "this host could not look".
	if (orienting && ctx.catalog) {
		catalog = { modules: await ctx.catalog.list() }
	} else if (orienting) {
		// The house rule from `run_checks` and `workbench`: a category this host
		// could not evaluate is NAMED, never dropped. An absent catalog silently
		// omitted reads exactly like a catalog with nothing in it, and "there is
		// nothing to install" is the one conclusion that must not be reachable by
		// accident — it is the whole answer to "what could I be using?".
		unavailable.push({
			name: 'catalog',
			reason:
				'this host wired no bundle catalog, so what is installable here is UNKNOWN — not empty',
			remedy:
				'Run inside `maxstack mcp`, or call `maxstack add --list` in a shell.',
		})
	}

	const slugs = Array.isArray(args.with) ? args.with.map(String) : null
	const install = slugs && ctx.catalog ? await ctx.catalog.preview(slugs) : null
	if (slugs && !ctx.catalog)
		unavailable.push({
			name: 'install-preview',
			reason: `no catalog is wired here, so ${slugs.join(', ')} could not be previewed`,
			remedy: 'Run inside `maxstack mcp`.',
		})

	// Same permissive-empty trap as `review_queue`: with no `ownershipKnown` the
	// risk model assumes everything is owned, so the fallback is an explicit
	// unknown rather than a default that quietly batches more than it should.
	const risk = (await ctx.ownership?.riskContext?.()) ?? ({} as RiskContext)
	const proposals = pendingProposals(now, risk)

	const report: InitReport = {
		project: {
			title: now.product.meta.title,
			status: now.product.meta.status,
			// #343: `maxstack init` writes a structurally complete product doc, so
			// an agent reading `problem` or `personas` here gets fluent English
			// whether or not a human ever wrote a word of it. Named, never
			// omitted — the same rule `unavailable` applies to a check that could
			// not run, for the same reason: unwritten and written must not look
			// alike.
			...(unauthoredPrdNotice(now.product)
				? { productDoc: unauthoredPrdNotice(now.product) }
				: {}),
			requirements: now.product.requirements.length,
			entities: now.data.entities.length,
			pages: now.pages.pages.length,
			pricingTiers: now.pricing.tiers.length,
			decisions: effectiveDecisions(now.ledger).length,
			opsApplied: now.opLog.length,
		},
		requirements: now.product.requirements.map((r) => ({
			id: r.id,
			priority: r.priority,
			userStory: r.userStory,
			acceptanceCriteria: r.acceptanceCriteria,
		})),
		...(orienting
			? {
					data: now.data,
					pages: now.pages,
					slots: slotInventory(now),
					api: apiContract(groundedEntityShapes(now)),
				}
			: {}),
		theme: resolveTheme(now),
		...(orienting
			? { vocabulary: vocabularyFor(args.vocabulary === 'full') }
			: {}),
		generators: ctx.generators.list(),
		checks: ctx.checks.list(),
		...(orienting ? { catalog } : {}),
		install,
		pending: {
			count: proposals.length,
			groups: groupForBulkReview(proposals),
			needsAttention: proposals
				.filter((p) => !p.risk.batchable)
				.map((p) => ({ target: p.target, label: p.label, risk: p.risk })),
			settleWith:
				'maxstack review --accept <selector> (or the workbench bulk pane). No tool on this surface decides — an agent settling its own proposals is a rubber stamp with a protocol in front of it.',
		},
		unavailable,
		batch,
		omitted: orienting ? null : BATCH_OMISSION,
		headline: headlineFor(now, batch, unavailable),
	}
	return { report, saved }
}

function headlineFor(
	spec: SpecSystem,
	batch: InitBatch | null,
	unavailable: UnavailableCheck[],
): string {
	const shape = `"${spec.product.meta.title}": ${spec.data.entities.length} entit${spec.data.entities.length === 1 ? 'y' : 'ies'}, ${spec.pages.pages.length} page(s), ${spec.opLog.length} op(s) applied.`
	const doc = unauthoredPrdNotice(spec.product)
	const unwritten = doc ? ` ${doc}` : ''
	const gap =
		unavailable.length > 0
			? ` ${unavailable.length} part(s) of this picture could not be answered by this host — see \`unavailable\`; they are unknown, not empty.`
			: ''
	// Said here as well as in `omitted`, because the headline is the one field a
	// caller is certain to read. A batch reply is the trimmed one, always.
	const trim = batch
		? ` Orientation was TRIMMED for this batch reply — ${BATCH_OMISSION.keys.map((k) => `\`${k}\``).join(', ')} are omitted, not empty; call init with no \`ops\` for the whole picture.`
		: ''
	return batch
		? `${batch.headline} ${shape}${unwritten}${gap}${trim}`
		: `${shape}${unwritten}${gap}`
}
