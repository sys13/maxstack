/**
 * The L3 **platform tools** — the MCP surface a *spec-driving* agent uses, layered
 * on top of Sprout's per-resource CRUD tools. {@link PLATFORM_TOOL_NAMES} is the
 * list; three of them are host-gated ({@link HOST_GATED_TOOLS}).
 *
 * This docblock used to name eight of them inline, and was four tools stale by the
 * time somebody read it — the same failure #242 is about, one layer up. The names
 * live in one array now and this says where.
 *
 * They are deliberately **self-describing** (open decision #6, whose exit test
 * is exactly this): the tool descriptions + `query_spec {section:"ops"}` carry
 * enough of the spec-op vocabulary that a non-Claude agent with no skills can
 * still drive the loop — discover the ops, propose one (validated, diffed, not
 * written), apply it (suggest→accept), regenerate, and check. The skills become
 * thin playbooks over this surface rather than the sole home of the knowledge.
 *
 * `propose_spec_change` never writes — it validates + diffs a typed op. Only
 * `apply_spec_change` (and `record_decision`, its decision-shaped convenience)
 * mutate, and only through {@link applyOp}, so a broken spec can never land.
 *
 * ## Every successful result carries `warnings` and `next`
 *
 * Descriptions are read once, at session start. Results are read at every
 * decision point. So the steering that has to reach an agent *while it is
 * deciding* lives in the payload, uniformly, on every tool — see `steering.ts`.
 * Object payloads are extended with the pair; array and scalar payloads move
 * under `result` so the envelope is the same shape everywhere.
 *
 * ## Every mutation answers twice: `diff` and `effect`
 *
 * `diff` is written in the spec's own vocabulary — *what changed in the
 * document*. `effect` is the same op read off the derived-surface inventory —
 * *what changed in the running application*, up to and including "nothing did"
 *. The two diverge exactly when an op is shadowed, superseded or
 * ungrounded, which is precisely when a caller reporting the diff as its work
 * would be reporting something that never happened.
 */

import {
	apiContract,
	type JsonSchema,
	type McpExposure,
	type McpTool,
	type McpToolResult,
	mcpFail,
	type PageContract,
	pageContract,
} from '@maxstack/core'
import {
	applyOp,
	diffOp,
	effectiveDecisions,
	groupForBulkReview,
	type LedgerEntry,
	type OpId,
	type PageSpec,
	pendingProposals,
	type ReviewTarget,
	type RiskContext,
	resolveTheme,
	SPEC_OP_NAMES,
	SPEC_OP_VOCABULARY,
	type SpecOp,
	type SpecSystem,
	unauthoredPrdNotice,
	unauthoredPrdSections,
	validateOpDryRun,
} from '@maxstack/spec'
import { argErrors } from './args.ts'
import { attentionReport, specIfAllAccepted } from './attention.ts'
import {
	blastRadius,
	deriveSurfaces,
	latentExposure,
	type OpEffect,
	opEffect,
} from './blast-radius.ts'
import type {
	DefectReport,
	PlatformContext,
	UnavailableCheck,
} from './context.ts'
import { PlatformToolError } from './errors.ts'
import { groundedEntityShapes, resourceName } from './grounding.ts'
import { initReport } from './init.ts'
import { slotInventory } from './slots.ts'
import { type SteeringFacts, steer } from './steering.ts'

// ===========================================================================
// Tool names
// ===========================================================================

export const PLATFORM_TOOL_NAMES = [
	// First, deliberately: an agent reads this list top-down at session start, and
	// the one call that tells it what everything else is for belongs where it will
	// be read before the fishing expedition it replaces.
	'init',
	// These three are in `tools/list` only when the host wired the provider behind
	// them, and always routable — a call that arrives without one gets a named
	// error rather than "unknown tool". Which provider, and why, is declared once
	// in `HOST_GATED_TOOLS` below rather than in a comment here; that is what the
	// generated reference reads to document them.
	'browse_catalog',
	'ownership_drift',
	'review_cost',
	// Always present: the queue and its risk classification are spec facts, so
	// every host can answer them. Read-only on purpose — see the
	// tool's own description for why an agent must not settle its own review.
	'review_queue',
	// Always present, like review_queue: the ordering is a spec fact. Disk facts it
	// cannot see (drift, upgrades) are named as unevaluated rather than omitted, so
	// a thin host's clean report can never be mistaken for a complete one.
	'workbench',
	'query_spec',
	'propose_spec_change',
	'apply_spec_change',
	'run_generator',
	'run_checks',
	'explain_feature',
	'list_acceptance_criteria',
	'record_decision',
	// Always present, even where no sink is wired. An agent files an
	// observation into whatever write-shaped tool it can reach; the absence of
	// this one did not produce silence, it produced a framework bug memorialized
	// in the append-only decision ledger as a resolved architectural choice.
	'report_defect',
] as const

export type PlatformToolName = (typeof PLATFORM_TOOL_NAMES)[number]

const PLATFORM_TOOL_SET = new Set<string>(PLATFORM_TOOL_NAMES)

/** Does this tool name belong to the platform surface (vs Sprout CRUD)? */
export function isPlatformTool(name: string): boolean {
	return PLATFORM_TOOL_SET.has(name)
}

// ===========================================================================
// tools/list — self-describing definitions (built per-context so generator +
// check names appear as enums the agent can read straight off the schema)
// ===========================================================================

const QUERY_SECTIONS = [
	'summary',
	'product',
	'requirements',
	'data',
	'pages',
	'pricing',
	'ledger',
	'oplog',
	'ops',
	'theme',
	'slots',
	'api',
] as const

/**
 * Built on demand, not at module load, because `SPEC_OP_NAMES` crosses a package
 * boundary and this module sits in an import cycle with the one that defines it.
 * As a module-level `const` the spread ran during evaluation, and under the
 * bundler's chunking the two modules can be ordered so that it runs *first* —
 * `SPEC_OP_NAMES` is then still in its temporal dead zone and the whole server
 * dies at boot with "SPEC_OP_NAMES is not iterable". A cycle that resolves by
 * luck resolves differently every time the chunk graph shifts, so the fix is to
 * stop reading the binding at init rather than to hope for a kinder order.
 *
 * Every caller is inside `platformTools()` already, so nothing needs this before
 * the first tool listing. Memoized because that listing is per-request.
 */
let opArgSchemaCache: JsonSchema | undefined
function opArgSchema(): JsonSchema {
	opArgSchemaCache ??= {
		type: 'object',
		properties: {
			op: {
				type: 'string',
				enum: [...SPEC_OP_NAMES],
				description:
					'The spec-op name. Call query_spec {section:"ops"} for the full vocabulary — every op\'s layer and summary — and query_spec {section:"ops", ops:[...]} for the JSON Schema of the args of the ones you name.',
			},
			args: {
				type: 'object',
				description:
					'The op-specific arguments (e.g. data.addField needs {entityId, field:{id,name,type,required}}, where field.type is one of string|number|boolean|date|enum|json — use "string" for text, not "text"). On add-op rows, provenance is optional and best OMITTED — the server stamps the correct default; if supplied it must be the full {isSuggested, isAccepted, isAddedManually, suggestedDescription, priority} object. Structural ops are additive, except the set-ops: page.setBlockOrder retunes an existing table block\'s {pageId, blockId, order:{field, direction}}; page.setBlockVariant sets its presentation {pageId, blockId, variant: "table"|"cards"|"feed"}; page.setBlockFields picks which entity fields it renders and in what order {pageId, blockId, fields:["title","rating",…]} (first = the title column); theme.set replaces the whole app theme {theme:{preset, accent?, radius?, density?, font?, typeScale?}} (last-wins).',
			},
		},
		required: ['op', 'args'],
	}
	return opArgSchemaCache
}

/**
 * The tools a host only gets if it wired the provider behind them, and what to
 * wire.
 *
 * This exists because the gate used to be three inline `...(ctx.x ? [tool] : [])`
 * spreads, which made "is this tool host-gated, and on what?" a fact you could
 * only recover by reading the array. `gen-reference-docs.ts` could not recover it
 * at all, so `docs/mcp-reference.md` — built from a context with no optional
 * providers — silently omitted all three, and the validate gate drift-checked that
 * omission as correct. A reference that understates the surface by a third, while
 * being verified, is worse than one nobody checks.
 *
 * So the gate is data. `platformTools` filters on it, the reference annotates from
 * it, and neither can drift from the other because there is only one of it.
 */
export const HOST_GATED_TOOLS = {
	ownership_drift: {
		provider: 'ownership',
		requires:
			'a host with a filesystem, since drift compares files on disk against their derivation. `maxstack mcp` has one; a remote host may not',
	},
	review_cost: {
		provider: 'reviewCost',
		requires:
			'a project that opted into review-cost telemetry. Absent means nobody measured, which is not the same as review being free',
	},
	browse_catalog: {
		provider: 'catalog',
		requires:
			'a host that wired the bundle catalog, since `@maxstack/mcp` deliberately does not import `@maxstack/features`',
	},
} as const satisfies Record<
	string,
	{ provider: keyof PlatformContext; requires: string }
>

/** Is this tool present only when its host wired something? */
export function hostGate(
	name: string,
): { provider: string; requires: string } | null {
	return (
		(
			HOST_GATED_TOOLS as Record<string, { provider: string; requires: string }>
		)[name] ?? null
	)
}

export function platformTools(ctx: PlatformContext): McpTool[] {
	const generatorNames = ctx.generators.list().map((g) => g.name)
	const checkNames = ctx.checks.list().map((c) => c.name)
	const all: McpTool[] = [
		{
			name: 'init',
			description:
				"CALL THIS FIRST, before anything else, in every session. One call for the whole picture: what this project is, every entity, page, requirement and slot it declares, the API it serves, the FULL spec-op vocabulary with the JSON Schema for each op's args, the generators and checks available here, the installable bundle catalog, and what is already pending review. It answers \"what am I working on, and what could I be using that I do not know exists?\" — which is otherwise eight separate query_spec/browse_catalog/review_queue calls, and in practice does not get asked at all, because an agent that reads a summary stops there and hand-builds what a bundle would have given it. Anything this host cannot answer is NAMED in `unavailable` rather than omitted, so a thin host's short report can never be mistaken for a complete one. Optionally pass `ops` — a whole batch of typed spec-ops validated as one unit, each against the spec the previous ones would produce, so `data.addEntity` plus its eight `data.addField`s is ONE call instead of nine. The batch is all-or-nothing (one op refuses, nothing is written) and reports ONE merged app-shaped `effect` for the chain rather than an unreadable pile of per-op ones. `apply` defaults to false: without it nothing is written and you get the effect to consent to first. This does NOT scaffold a project — `maxstack init` is the human's entry point and this tool only ever runs inside a project that already exists.",
			inputSchema: {
				type: 'object' as const,
				properties: {
					ops: {
						type: 'array',
						description:
							'An opening batch of typed spec-ops, in order, each {op, args} exactly as propose_spec_change takes one. Validated as a unit against the running projection, so later ops may depend on earlier ones. All-or-nothing.',
						items: opArgSchema(),
					},
					apply: {
						type: 'boolean',
						description:
							'With `ops`: commit the batch (default false — validate, diff and report the merged effect, writing nothing). Applied rows land ACCEPTED with AI provenance and go live immediately; they are not queued for review, so say this out loud rather than defaulting into it.',
					},
					with: {
						type: 'array',
						description:
							'Bundle slugs to preview installing, as browse_catalog {preview} would. Nothing is installed.',
						items: { type: 'string' },
					},
					vocabulary: {
						type: 'string',
						enum: ['summary', 'full'],
						description:
							'How much of the op vocabulary to return. "summary" (default) is every op\'s name, layer and one-line summary — what you need to know an op EXISTS — and costs about a sixth of "full", which adds the JSON Schema for every op\'s args. Prefer the default: "full" is ~170k characters and most hosts REFUSE a response that size. You never have to guess an arg shape either way, because query_spec {section:"ops", ops:["page.addPage", ...]} returns the schemas for the ops you name, a handful at a time.',
					},
				},
			},
		},
		{
			name: 'query_spec',
			description:
				'Read the project spec, or the API generated from it. Pick a section; "summary" gives counts + title, "ops" lists the spec-op vocabulary you can propose — pass `ops` alongside it to get the JSON Schema for those ops\' args, so you never have to guess the arg shape — "requirements" lists ids + user stories + acceptance criteria, "data" lists the entities and their fields as the SPEC declares them, "api" is what a CLIENT talks to (per resource: the REST routes, plus a JSON Schema for the POST body and for the PATCH body, including which fields accept null to clear them) so you never have to probe a running server, "pages" lists the declared pages and — beside each — the contract of the page\'s OWN routes (`<route>`, `<route>/new`, `<route>/parse`, `<route>/:id`) with the payload shape each one accepts, so driving the app the way a USER does needs no probing either, and "slots" lists every place bespoke UI can be written *without* ejecting (page-level extension slots plus the derived block-level slots, with the typed props each one receives).',
			inputSchema: {
				type: 'object',
				properties: {
					section: {
						type: 'string',
						enum: [...QUERY_SECTIONS],
						description:
							'Which slice of the spec to return (default "summary").',
					},
					ops: {
						type: 'array',
						items: { type: 'string', enum: [...SPEC_OP_NAMES] },
						description:
							'With section "ops": the op names whose full arg JSON Schema you want, e.g. ["page.addPage","data.addField"]. Ask for the handful you are about to use — all 60 schemas at once is ~107k characters and hosts refuse a response that size. Omit it to get every op\'s name, layer and summary without the schemas.',
					},
				},
			},
		},
		{
			name: 'workbench',
			description:
				'What needs you, in order, worst first — the answer to "what should I look at?" rather than a list of panels to check. Public exposure that would change ranks above a removal, which ranks above a proposal that cannot be batched, which ranks above drift, which ranks above the routine majority (collapsed into one line, because the routine rows are what the surface exists to make cheap). Every item carries WHY it outranks the next one, and names specific rows rather than a count — nobody can act on a badge. Categories this host cannot evaluate are listed in `unavailable` and the headline refuses to say "nothing needs you" when something went unchecked, because an empty report from a surface that could not look reads exactly like an all-clear from one that did. Read-only. Section `exposure` returns every publicly-reachable field plus the declared-but-not-live portals that are one op away from being public; section `blast-radius` takes a `target` and reports what accepting it does to the built application — which tables, columns, routes, forms, REST payloads and public fields appear, change or STOP EXISTING — because a spec diff under-describes the blast radius and blast radius is what is actually being decided on.',
			inputSchema: {
				type: 'object' as const,
				properties: {
					section: {
						type: 'string',
						enum: ['attention', 'exposure', 'blast-radius'],
						description:
							'Which view to return (default "attention" — the ordered what-needs-you list).',
					},
					target: {
						type: 'object',
						description:
							'For section "blast-radius": the pending proposal to explain, as {kind, id, parentId?}. Omit to report the effect of accepting everything pending.',
					},
				},
			},
		},
		{
			name: 'review_queue',
			description:
				'The review queue: every proposal still undecided, each with a risk classification and the reasons behind it, grouped into the batches that could be cleared in one decision. Also reports which proposals can NEVER be batched (access control, destructive changes, anything the model does not understand) and why. READ-ONLY, and deliberately so: this tool will not accept or reject anything. An agent settling its own proposals is not review, it is a rubber stamp with a protocol in front of it — so use this to tell the maintainer what is waiting and how cheaply it could be cleared ("12 routine fields on Order batch as field:e-order; viewerRole needs you"), and leave the decision to `maxstack review --accept <selector>` or the workbench pane. Risk here is conservative by construction: it starts at high and only known-safe patterns lower it, so an unfamiliar proposal reads as needing attention rather than as fine.',
			inputSchema: { type: 'object' as const, properties: {} },
		},
		{
			name: 'ownership_drift',
			description:
				'Report what the maintainer owns — ejected files and filled slots — what each was derived from, and how far behind the current derivation it has drifted, with a unified diff per drifted file. Read-only and non-prescriptive: nothing is applied, and drift is not an error. An ejected file that has diverged is a file doing what ejecting it was for; a filled slot is reported as "authored" because the generator seeded it once and never derives it again. Use this to answer "what am I missing by owning this?" before proposing an eject, and after a bundle upgrade to see what moved underneath a file the platform is not allowed to touch.',
			inputSchema: { type: 'object' as const, properties: {} },
		},
		{
			name: 'review_cost',
			description:
				'What approving a change costs the maintainer: engaged time per proposal (attention, with gaps over the idle cutoff excluded), separated from wall-clock elapsed time and never blended with it. Returns the summary, the per-decision rows and the cumulative curve, or null when the project has not opted in — null means nobody measured, NOT that review is free. Read-only. This is the human half of "minutes, not hours": a platform that lands a change in seconds and costs its maintainer twenty minutes to approve has not made anything faster. Use it to check whether the review surface is staying cheap as a project grows, and never as a target for how fast a person should review.',
			inputSchema: { type: 'object' as const, properties: {} },
		},
		{
			name: 'browse_catalog',
			description:
				'Browse the installable feature-bundle catalog, and preview what installing one would do. With no arguments: every module with its title, one-line description, transitive prerequisites, what it contributes, and — inside a project — what is installed and what could be upgraded. With `preview: ["billing"]`: the exact spec ops the install would apply, the prerequisites it would pull in that you did not ask for, and any reason it would be refused. Nothing is written; installing is `maxstack add <slug>` (or the same ops through apply_spec_change).',
			inputSchema: {
				type: 'object' as const,
				properties: {
					preview: {
						type: 'array',
						description:
							'Bundle slugs to preview installing, in order. Omit to list the catalog.',
						items: { type: 'string' },
					},
				},
			},
		},
		{
			name: 'propose_spec_change',
			description:
				'Validate + diff a typed spec-op WITHOUT applying it (the "suggest" half of suggest→accept). Returns {valid, errors, diff, effect, warnings, next}. `diff` is spec-shaped — what the document would say; `effect` is app-shaped — which tables, columns, routes, forms, REST payloads and public fields would appear, change or STOP EXISTING if you applied it, and it can say the op would change nothing anyone can see. Always propose before apply.',
			inputSchema: opArgSchema(),
		},
		{
			name: 'apply_spec_change',
			description:
				'Apply a typed spec-op to the spec (the "accept" half — applied rows land accepted with AI provenance and go live in the running app immediately). Re-validates server-side and rejects any op that would break referential integrity; logs it to the op-log with provenance. Returns {applied, diff, effect, warnings, next}. READ `effect` and `warnings` before you report what you changed — `diff` is spec-shaped and cannot tell you that what you applied changes nothing a user can see (a shadowed block, an unbuilt app, a row nothing has accepted yet). `effect.changesBuiltApp === false` means the document moved and the application did not; `null` means this layer is outside what the surface inventory models, which is not the same as "no effect".',
			inputSchema: opArgSchema(),
		},
		{
			name: 'run_generator',
			description:
				'Run a code generator against the current spec. This is how spec changes become code. Returns {generator, artifacts, notes} — and WHICH of the two carries the result depends on the host, so read both. A host that cannot write (the web workbench) returns the files as data in `artifacts` ({path, content}) for review. A disk-backed host (the CLI over stdio) has already LANDED them, never-clobber, and reports one line per file in `notes` ("created:", "overwritten:", "appended:", "unchanged:", "skipped-user-owned:", "wrote:") with `artifacts` EMPTY — because echoing back content that is already on disk is a second copy of the same bytes with no reader. An empty `artifacts` therefore does NOT mean nothing was generated; on stdio it is the normal, successful shape, and `notes` is the record of what changed.',
			inputSchema: {
				type: 'object',
				properties: {
					generator: {
						type: 'string',
						enum: generatorNames,
						description: 'Which generator to run.',
					},
					args: {
						type: 'object',
						description: 'Optional generator arguments.',
					},
				},
				required: ['generator'],
			},
		},
		{
			name: 'run_checks',
			description:
				'Run the validate gate. Omit "checks" to run all. Returns {ok, status, ran, results, unavailable, headline}. `ok` is true ONLY when every check this host knows about actually ran and passed: anything that could not run is listed in `unavailable` with a reason and a remedy, and `status` is then "incomplete", never a green. The one exception is an entry marked `blocking: false`, which had nothing to examine (a project with no owned code yet) — still named, but it does not withhold the green. Read `unavailable` before calling a change done — a check that never executed reads exactly like one that passed, and unexamined code is how a typecheck gets skipped for a whole session.',
			inputSchema: {
				type: 'object',
				properties: {
					checks: {
						type: 'array',
						items: { type: 'string', enum: checkNames },
						description: `Which checks to run (default all). Available: ${checkNames.join(', ')}.`,
					},
				},
			},
		},
		{
			name: 'explain_feature',
			description:
				'Project-tailored explanation of one feature: pass a requirementId (r-…), entityId (e-…), or pageId (pg-…) and get its user story, acceptance criteria, edge cases, and cross-layer links.',
			inputSchema: {
				type: 'object',
				properties: {
					requirementId: { type: 'string', description: 'e.g. "r-login".' },
					entityId: { type: 'string', description: 'e.g. "e-order".' },
					pageId: { type: 'string', description: 'e.g. "pg-checkout".' },
				},
			},
		},
		{
			name: 'list_acceptance_criteria',
			description:
				'The acceptance criteria to build/verify against. Pass a requirementId for one; omit it for every requirement.',
			inputSchema: {
				type: 'object',
				properties: {
					requirementId: {
						type: 'string',
						description: 'A single r-… id, or omit for all.',
					},
				},
			},
		},
		{
			name: 'record_decision',
			description:
				'Append a decision THIS PROJECT made to the append-only ledger (options + recommendation + choice + rationale). Convenience wrapper over the prd.recordDecision spec-op. Omit chosenOptionId to record a still-pending decision. Append-only: an entry written here cannot be taken back, so it is the wrong home for anything you are not choosing on purpose. A maxstack bug, a workaround for one, or "the framework did the wrong thing so I did X" is a DEFECT — use report_defect, which is built for it.',
			inputSchema: {
				type: 'object',
				properties: {
					id: { type: 'string', description: 'Decision id (d-…).' },
					question: { type: 'string' },
					options: {
						type: 'array',
						description: 'Each option: {id, description, pros[], cons[]}.',
						items: { type: 'object' },
					},
					recommendedOptionId: { type: 'string' },
					chosenOptionId: {
						type: 'string',
						description: 'Omit to leave the decision pending.',
					},
					rationale: { type: 'string' },
				},
				required: ['id', 'question', 'options', 'rationale'],
			},
		},
		{
			name: 'report_defect',
			description:
				'Report a defect in maxstack ITSELF — the platform, its generated code, its CLI, its API or its docs. Use this the moment you hit one, while you still have the facts: the call you made, what you expected, what happened, and the workaround you used. This is NOT record_decision: a framework bug is not an architectural choice, and writing one into the append-only decision ledger both pollutes the ledger and loses the report. Use record_decision for a choice this PROJECT made; use this for "the platform did the wrong thing". Nothing about your spec or your app changes — this only files the report. Whether it is actually PERSISTED depends on the host, so read `recorded`: the CLI over stdio has a defect sink and answers `{recorded: true, where}`; a host without one (the web workbench) answers `{recorded: false, where: null}` with the filled-in `report` returned in full for you to carry upstream yourself. This tool is listed on every host regardless, because an agent with nowhere to put a defect puts it somewhere wrong.',
			inputSchema: {
				type: 'object',
				properties: {
					title: {
						type: 'string',
						description:
							'One line, specific: "PATCH rejects null on a nullable column", not "update is broken".',
					},
					surface: {
						type: 'string',
						enum: [
							'mcp',
							'rest-api',
							'cli',
							'runtime',
							'generated-code',
							'docs',
							'other',
						],
						description: 'Which part of the platform misbehaved.',
					},
					severity: {
						type: 'string',
						enum: ['blocks', 'workaround', 'annoyance'],
						description:
							'blocks = there is no way through; workaround = you got past it but paid; annoyance = it cost you nothing but is wrong.',
					},
					what: {
						type: 'string',
						description:
							'What you did, concretely enough to reproduce: the exact tool call, request or command.',
					},
					expected: {
						type: 'string',
						description: 'What should have happened.',
					},
					actual: {
						type: 'string',
						description:
							'What actually happened — paste the real error or output, not a paraphrase.',
					},
					workaround: {
						type: 'string',
						description:
							'What you did instead, if anything. Optional, and worth more than it looks: it is the evidence of what the defect actually cost.',
					},
				},
				required: [
					'title',
					'surface',
					'severity',
					'what',
					'expected',
					'actual',
				],
			},
		},
	]

	// One filter, over {@link HOST_GATED_TOOLS}, rather than three inline spreads.
	// A host that did not wire the provider does not get the tool — same behaviour
	// as before — but the *reason* is now a value the reference generator can read,
	// which is what stops the docs from silently understating the surface.
	return all.filter((tool) => {
		const gate = HOST_GATED_TOOLS[tool.name as keyof typeof HOST_GATED_TOOLS]
		return !gate || ctx[gate.provider] != null
	})
}

// ===========================================================================
// tools/call — the executor
// ===========================================================================

function ok(data: unknown): McpToolResult {
	return { content: [{ type: 'text', text: JSON.stringify(data) }] }
}
function err(message: string): McpToolResult {
	return { content: [{ type: 'text', text: message }], isError: true }
}

/**
 * The op vocabulary, narrowed to the ops actually asked for.
 *
 * All 60 schemas at once is 107k characters, and the reference host does not
 * charge for that — it REFUSES it. Which made the one documented route to an
 * arg schema have no working form, and the four strings promising "you never
 * have to guess an arg shape" false.
 *
 * So the schemas are reachable a handful at a time, which is how they are
 * needed: an agent arrives here already holding the names, because `init`'s
 * cheap summary half is exactly the list of names. Unfiltered, this returns
 * that same summary rather than the payload that cannot come back — a partial
 * answer plus the way to finish it beats an error the caller cannot act on.
 */
function opsSection(names: unknown): unknown {
	const all = Object.values(SPEC_OP_VOCABULARY)
	const wanted = Array.isArray(names)
		? names.filter((n): n is string => typeof n === 'string')
		: []
	if (wanted.length === 0)
		return {
			count: all.length,
			ops: all.map((v) => ({
				name: v.name,
				layer: v.layer,
				summary: v.summary,
			})),
			argSchemas:
				'OMITTED — all 60 at once is ~107k characters and hosts refuse a payload that size. Ask for the ones you need: query_spec {section:"ops", ops:["page.addPage","data.addField"]}.',
		}
	const known = new Map<string, (typeof all)[number]>(
		all.map((v) => [v.name, v]),
	)
	const found = wanted.filter((n) => known.has(n))
	const unknownNames = wanted.filter((n) => !known.has(n))
	return {
		ops: found.map((n) => known.get(n)),
		...(unknownNames.length > 0
			? {
					unknown: unknownNames,
					note: `Not ops in this vocabulary: ${unknownNames.join(', ')}. Call query_spec {section:"ops"} with no filter for the full list of names.`,
				}
			: {}),
	}
}

/**
 * The page's **own** routes and what each accepts (#376).
 *
 * `section: "api"` describes `/api/<resource>`; this describes the URLs the app
 * actually renders links and forms to, which is what an e2e-shaped verification
 * drives. Both come from `@maxstack/core` — this one from the same endpoint list
 * the runtime's actions compose their 405s and 400s out of, so the contract
 * published here cannot describe a page that refuses it.
 */
const contractOf = (page: PageSpec): PageContract =>
	pageContract({
		route: page.route,
		resource: page.entityId ? resourceName(page.entityId) : null,
	})

function querySection(
	spec: SpecSystem,
	section: string,
	args: Record<string, unknown> = {},
): unknown {
	switch (section) {
		case 'product': {
			// The doc, plus what in it was never written (#343). A PRD that reads
			// as authored but is not is worse than an absent one: an agent
			// grounding on `problem.statement` cannot tell a decision from the
			// scaffold `maxstack init` left behind, so the gap is named beside the
			// content rather than left to be inferred.
			const unauthored = unauthoredPrdSections(spec.product)
			if (unauthored.length === 0) return spec.product
			return {
				...spec.product,
				unauthored,
				note: unauthoredPrdNotice(spec.product),
			}
		}
		case 'requirements':
			return spec.product.requirements.map((r) => ({
				id: r.id,
				priority: r.priority,
				userStory: r.userStory,
				acceptanceCriteria: r.acceptanceCriteria,
			}))
		case 'data':
			return spec.data
		case 'pages':
			// The declared pages, each carrying the contract of its own routes —
			// the thing #376's session grepped rendered HTML for and still guessed
			// wrong about twice. Only the endpoint list is added, not the REST
			// schemas it points at: `section:"api"` already carries those, and
			// inlining them per page is how the ops section reached 107k characters.
			return {
				...spec.pages,
				pages: spec.pages.pages.map((page) => ({
					...page,
					contract: contractOf(page),
				})),
			}
		case 'slots':
			// Where bespoke code goes without ejecting. Availability
			// only: fill state is a disk fact, and the MCP context has a spec store,
			// not a filesystem. `filled` is therefore absent rather than false —
			// `maxstack slots` and the workbench are the surfaces that can see it.
			return slotInventory(spec)
		case 'pricing':
			return spec.pricing
		case 'ledger':
			return effectiveDecisions(spec.ledger)
		case 'oplog':
			return spec.opLog
		case 'ops':
			return opsSection(args.ops)
		case 'api':
			// The GENERATED API, not the spec. Derived through the same
			// spec -> table -> resource -> zod fold the request path validates with,
			// so it cannot describe an API different from the one being served —
			// which is the only reason publishing a contract is worth anything.
			return apiContract(groundedEntityShapes(spec))
		case 'theme':
			// Resolved, not raw: an agent asking "what does this app look like"
			// should see the effective zinc default, not an absent section.
			return resolveTheme(spec)
		default:
			return {
				title: spec.product.meta.title,
				status: spec.product.meta.status,
				// Present only when there IS a gap, so the common case costs
				// nothing — but never absent while the gap exists, because the
				// summary is the one section every session reads.
				...(unauthoredPrdNotice(spec.product)
					? { productDoc: unauthoredPrdNotice(spec.product) }
					: {}),
				requirements: spec.product.requirements.length,
				entities: spec.data.entities.length,
				pages: spec.pages.pages.length,
				pricingTiers: spec.pricing.tiers.length,
				decisions: effectiveDecisions(spec.ledger).length,
				opsApplied: spec.opLog.length,
				theme: resolveTheme(spec).preset,
			}
	}
}

function explain(spec: SpecSystem, args: Record<string, unknown>): unknown {
	const reqId = args.requirementId
	if (typeof reqId === 'string') {
		const r = spec.product.requirements.find((x) => x.id === reqId)
		if (!r) throw new PlatformToolError(`Unknown requirement "${reqId}"`)
		const metrics = new Map(
			[
				spec.product.goals.northStarMetric,
				...spec.product.goals.supportingMetrics,
			].map((m) => [m.id, m.name]),
		)
		return {
			kind: 'requirement',
			id: r.id,
			priority: r.priority,
			userStory: r.userStory,
			acceptanceCriteria: r.acceptanceCriteria,
			edgeCasesAndErrorStates: r.edgeCasesAndErrorStates,
			servesMetrics: (r.servesMetricIds ?? []).map((m) => metrics.get(m) ?? m),
			enhances: r.enhancesRequirementIds ?? [],
		}
	}
	const entId = args.entityId
	if (typeof entId === 'string') {
		const e = spec.data.entities.find((x) => x.id === entId)
		if (!e) throw new PlatformToolError(`Unknown entity "${entId}"`)
		return {
			kind: 'entity',
			id: e.id,
			name: e.name,
			description: e.description,
			fields: e.fields.map((f) => ({
				name: f.name,
				type: f.type,
				required: f.required,
			})),
			pages: spec.pages.pages
				.filter((p) => p.entityId === e.id)
				.map((p) => ({ id: p.id, route: p.route })),
		}
	}
	const pgId = args.pageId
	if (typeof pgId === 'string') {
		const p = spec.pages.pages.find((x) => x.id === pgId)
		if (!p) throw new PlatformToolError(`Unknown page "${pgId}"`)
		return {
			kind: 'page',
			id: p.id,
			name: p.name,
			route: p.route,
			entityId: p.entityId,
			blocks: p.blocks.map((b) => ({ id: b.id, type: b.type })),
			e2eTests: p.e2eTests ?? [],
			// Explaining a page without saying what it accepts is what left an
			// agent probing the live server for its delete shape (#376).
			contract: contractOf(p),
		}
	}
	throw new PlatformToolError(
		'explain_feature needs one of requirementId, entityId, or pageId',
	)
}

function acceptanceCriteria(
	spec: SpecSystem,
	args: Record<string, unknown>,
): unknown {
	const reqId = args.requirementId
	if (typeof reqId === 'string') {
		const r = spec.product.requirements.find((x) => x.id === reqId)
		if (!r) throw new PlatformToolError(`Unknown requirement "${reqId}"`)
		return { id: r.id, acceptanceCriteria: r.acceptanceCriteria }
	}
	return spec.product.requirements.map((r) => ({
		id: r.id,
		acceptanceCriteria: r.acceptanceCriteria,
	}))
}

/** Coerce the loose `{op, args}` wire shape into a `SpecOp` for validation. */
function toSpecOp(args: Record<string, unknown>): SpecOp {
	return { op: args.op, args: args.args } as SpecOp
}

function decisionOp(
	ctx: PlatformContext,
	args: Record<string, unknown>,
): SpecOp {
	// No `?? ''`, no `?? []`. The ledger is append-only, so a
	// manufactured value here is a permanent record of something nobody said.
	// `id`, `question`, `options` and `rationale` are declared required and are
	// enforced as such at the dispatch boundary (`args.ts`) — by the time control
	// reaches here they are present, and if the schema ever stops saying so the
	// right failure is a loud one, not a blank entry.
	const chosen =
		typeof args.chosenOptionId === 'string' ? args.chosenOptionId : null
	const entry: LedgerEntry = {
		id: args.id as LedgerEntry['id'],
		question: args.question as string,
		options: args.options as LedgerEntry['options'],
		recommendedOptionId:
			typeof args.recommendedOptionId === 'string'
				? args.recommendedOptionId
				: undefined,
		chosenOptionId: chosen,
		rationale: args.rationale as string,
		status: chosen ? 'resolved' : 'pending',
		decidedAt: chosen ? ctx.now() : null,
		origin: ctx.origin,
		recordedAt: ctx.now(),
	}
	return { op: 'prd.recordDecision', args: { entry } }
}

/**
 * What a tool call did, for the steering pass that runs after it.
 *
 * Threaded through as a mutable record rather than returned, so the switch below
 * stays a switch of `return ok(…)` arms: every arm gets steering whether or not
 * it remembered to ask for it, which is the point of a uniform field.
 */
interface Trace {
	/** The spec as it stands AFTER the call — mutating tools replace it. */
	spec?: SpecSystem
	/** The op this call applied or validated, when there is one. */
	op?: SpecOp | null
	/** False when the call refused; steering then withholds build advice. */
	succeeded?: boolean
	/** What the op did to the built application, when the call computed it. */
	effect?: OpEffect
}

/** Validate + apply an op, persisting the new system. Shared by apply + record. */
async function applyAndSave(
	ctx: PlatformContext,
	spec: SpecSystem,
	op: SpecOp,
	trace: Trace,
): Promise<McpToolResult> {
	trace.op = op
	// The SAME validator propose runs: a payload propose blessed can
	// never be rejected here, and a bad one fails as structured
	// {applied:false, errors} the agent can act on, not a save-time throw.
	const errors = validateOpDryRun(spec, op, ctx.origin)
	if (errors.length) {
		trace.succeeded = false
		return {
			content: [
				{ type: 'text', text: JSON.stringify({ applied: false, errors }) },
			],
			isError: true,
		}
	}
	const id = ctx.nextOpId()
	const next = applyOp(spec, op, {
		id,
		origin: ctx.origin,
		// Who wrote the op, when the host knows that is not who asked for it
		// (issue #359). Absent for every host that serves a caller writing its own
		// ops, and `applyOp` then falls back to `origin` — the answer this had
		// before the field existed, so no existing path moves.
		...(ctx.authorship ? { authorship: ctx.authorship } : {}),
		appliedAt: ctx.now(),
		// The write-path id is ours to state — unless the host is reusing this
		// function in process and has its own declared path (issue #358). The
		// surface is never ours: an MCP tool is not proof of an MCP transport,
		// only the host knows what carried the request, and guessing produced a
		// browser click recorded as an agent's MCP write.
		actor: {
			...ctx.actor,
			surface: ctx.surface,
			path: ctx.writePath ?? 'mcp-apply-spec-change',
		},
	})
	await ctx.spec.save(next)
	trace.spec = next
	const applied = next.opLog[next.opLog.length - 1]
	// The document-shaped answer and the app-shaped one, side by side.
	// `diff` says what changed in the spec; `effect` says what changed in the
	// running application, and is able to say "nothing did" — the one thing a
	// spec-shaped diff structurally cannot express.
	const effect = opEffect(spec, next, op)
	trace.effect = effect
	return ok({ applied, diff: diffOp(op), effect })
}

/**
 * The spec an op *would* produce, in memory and never saved — `null` if applying
 * it throws.
 *
 * The op has already passed `validateOpDryRun` by the time this runs, so a throw
 * here is a defect rather than a caller error; it costs the reply its `effect`
 * field and nothing else. A propose call that answered `valid: true` and then
 * 500ed on the projection would be strictly worse than one that says less.
 */
function projectOp(
	spec: SpecSystem,
	ctx: PlatformContext,
	op: SpecOp,
): SpecSystem | null {
	try {
		return applyOp(spec, op, {
			id: 'op-propose-projection' as OpId,
			origin: ctx.origin,
			// Same authorship the real apply would use, so what propose projects and
			// what apply lands cannot disagree about the row's provenance.
			...(ctx.authorship ? { authorship: ctx.authorship } : {}),
			appliedAt: ctx.now(),
			// Discarded, but stamped honestly all the same: a projection that leaked
			// into a real op log should name the surface it actually came from.
			actor: { ...ctx.actor, surface: ctx.surface, path: 'propose-projection' },
		})
	} catch {
		return null
	}
}

/**
 * One proposal accepted, in memory, or `null` if the op validator refuses.
 *
 * `null` rather than a throw, and reported as a named error rather than a 500:
 * a caller naming a row that is not pending (or a kind that cannot be reviewed —
 * see #248) has made a legible mistake and deserves a legible answer.
 */
function applyReviewProjection(
	spec: SpecSystem,
	target: ReviewTarget,
): SpecSystem | null {
	try {
		return applyOp(
			spec,
			{ op: 'provenance.review', args: { target, action: 'accept' } },
			{
				id: 'op-blast-radius-projection' as OpId,
				origin: 'human',
				appliedAt: '1970-01-01',
				actor: { surface: 'mcp', path: 'blast-radius-projection' },
			},
		)
	} catch {
		return null
	}
}

/**
 * Fold the steering pair into a successful result.
 *
 * Applied here rather than in each arm on purpose: steering an agent only works
 * if it is on *every* reply, and a field the arms opt into is a field that goes
 * missing exactly where somebody forgot to think about it.
 *
 * Object payloads are extended in place; arrays and scalars move under `result`
 * so the envelope shape is the same everywhere. Errors are left alone — an error
 * message is already the payload the agent reads, and its repair instructions
 * belong in the message itself.
 */
async function withSteering(
	ctx: PlatformContext,
	spec: SpecSystem,
	tool: string,
	trace: Trace,
	res: McpToolResult,
): Promise<McpToolResult> {
	if (res.isError) return res
	let payload: unknown
	try {
		payload = JSON.parse(res.content[0]?.text ?? 'null')
	} catch {
		return res
	}
	// Only a host that can see disk answers this; an unwired host leaves it
	// `undefined`, and the staleness rule then does not fire at all rather than
	// reporting a build it cannot see as up to date.
	const facts: SteeringFacts = {}
	if (ctx.generation)
		facts.generatedFromOpCount = await ctx.generation.watermark()

	const steering = steer(spec, {
		tool,
		op: trace.op,
		effect: trace.effect,
		succeeded: trace.succeeded ?? true,
		facts,
	})
	const body =
		payload !== null && typeof payload === 'object' && !Array.isArray(payload)
			? { ...(payload as Record<string, unknown>), ...steering }
			: { result: payload, ...steering }
	return { content: [{ type: 'text', text: JSON.stringify(body) }] }
}

/**
 * `mcpFail` with the platform half's extra class (#353).
 *
 * Sprout's refusals are already classes, so `mcpFail` can test them. The
 * platform half's are {@link PlatformToolError}s — see `errors.ts` for the rule
 * that decides which of its messages earns one. Everything else falls through to
 * the shared boundary: generic plus a correlation id over a network transport,
 * the detail as well over a local one.
 *
 * Note what stays generic on the network host on purpose: a spec store that
 * cannot find its directory, a generator that throws mid-emit, a check runner
 * whose shell died. Those messages are about the *server's* filesystem, and on
 * the one host where the caller is not the machine's owner they are the only
 * thing here worth withholding.
 */
function platformFail(
	e: unknown,
	context: { resource: string; operation: string },
	exposure: McpExposure,
): McpToolResult {
	if (e instanceof PlatformToolError) return err(e.message)
	return mcpFail(e, context, exposure)
}

export async function executePlatformTool(
	ctx: PlatformContext,
	name: string,
	args: Record<string, unknown>,
	exposure: McpExposure = 'network',
): Promise<McpToolResult> {
	let spec: SpecSystem
	try {
		spec = await ctx.spec.load()
	} catch (e) {
		return platformFail(e, { resource: 'spec', operation: 'load' }, exposure)
	}
	// Declared-required enforcement, generically, before any arm runs. The
	// schemas are already published; checking them at the one boundary means no
	// tool can forget to, and a tool added tomorrow is covered the day its schema
	// is written rather than the day someone remembers.
	const schema = platformTools(ctx).find((t) => t.name === name)?.inputSchema
	if (schema) {
		const bad = argErrors(schema, args)
		if (bad.length > 0) return err(`${name}: ${bad.join(' ')}`)
	}

	const trace: Trace = {}
	const res = await dispatch(ctx, spec, name, args, trace, exposure)
	return withSteering(ctx, trace.spec ?? spec, name, trace, res)
}

async function dispatch(
	ctx: PlatformContext,
	spec: SpecSystem,
	name: string,
	args: Record<string, unknown>,
	trace: Trace,
	exposure: McpExposure,
): Promise<McpToolResult> {
	try {
		switch (name) {
			case 'init': {
				const { report, saved } = await initReport(ctx, spec, args)
				// Only a committed batch moves the spec. `trace.spec` drives the
				// steering pass, and steering that described a projection nobody saved
				// would be steering about an application that does not exist.
				if (saved) trace.spec = saved
				trace.succeeded = report.batch?.failedAt == null
				return ok(report)
			}

			case 'ownership_drift': {
				if (!ctx.ownership)
					return err(
						'ownership_drift: this host has no filesystem wired (see PlatformContext.ownership)',
					)
				return ok(await ctx.ownership.drift())
			}

			case 'workbench': {
				const inputs = (await ctx.attention?.inputs()) ?? {}
				const section =
					typeof args.section === 'string' ? args.section : 'attention'

				if (section === 'exposure') {
					// Live exposure and latent exposure together, because "what is public"
					// and "what becomes public the moment somebody un-pauses a portal" are
					// the same question asked one op apart.
					const surfaces = deriveSurfaces(spec).filter(
						(s) => s.kind === 'public-field' || s.kind === 'public-write',
					)
					return ok({
						public: surfaces,
						latent: latentExposure(spec),
						note:
							surfaces.length === 0 && latentExposure(spec).length === 0
								? 'No portal declares anything. Nothing in this project is publicly reachable.'
								: 'Every field listed under `public` is readable or writable by the internet right now. Everything under `latent` becomes public without further review.',
					})
				}

				if (section === 'blast-radius') {
					// A named target explains one proposal; no target explains the whole
					// pending queue. Both are the same fold over two specs.
					const target = args.target as ReviewTarget | undefined
					const after = target
						? applyReviewProjection(spec, target)
						: specIfAllAccepted(spec, inputs.risk ?? {})
					if (!after)
						return err(
							`workbench: ${target?.kind} "${target?.id}" is not a pending proposal this spec can accept — call review_queue for what is actually pending.`,
						)
					return ok({
						of: target ?? 'everything pending',
						...blastRadius(spec, after),
					})
				}

				return ok(
					attentionReport(spec, {
						...inputs,
						ifAccepted:
							inputs.ifAccepted ?? specIfAllAccepted(spec, inputs.risk ?? {}),
					}),
				)
			}

			case 'review_queue': {
				// A host that cannot supply ownership facts gets `{}` — with no
				// `ownershipKnown`, so the risk model assumes every surface is owned and
				// batches nothing. Empty is the *permissive* input here, which is why the
				// fallback has to be an explicit unknown rather than a bare default.
				const context =
					(await ctx.ownership?.riskContext?.()) ?? ({} as RiskContext)
				const proposals = pendingProposals(spec, context)
				return ok({
					pending: proposals.length,
					groups: groupForBulkReview(proposals),
					needsAttention: proposals
						.filter((p) => !p.risk.batchable)
						.map((p) => ({ target: p.target, label: p.label, risk: p.risk })),
					// Stated in the payload, not just in the tool description: an agent
					// reading this reaches for the next call, and the next call is not here.
					settleWith:
						'maxstack review --accept <selector> (or the workbench bulk pane). This tool does not decide.',
				})
			}

			case 'review_cost': {
				if (!ctx.reviewCost)
					return err(
						'review_cost: this host has no review-cost provider wired (see PlatformContext.reviewCost)',
					)
				return ok(await ctx.reviewCost.report())
			}

			case 'browse_catalog': {
				if (!ctx.catalog)
					return err(
						'browse_catalog: this host has no catalog wired (see PlatformContext.catalog)',
					)
				const slugs = Array.isArray(args.preview)
					? args.preview.map(String)
					: null
				return ok(
					slugs
						? await ctx.catalog.preview(slugs)
						: { modules: await ctx.catalog.list() },
				)
			}

			case 'query_spec':
				return ok(
					querySection(
						spec,
						typeof args.section === 'string' ? args.section : 'summary',
						args,
					),
				)

			case 'propose_spec_change': {
				const op = toSpecOp(args)
				const errors = validateOpDryRun(spec, op, ctx.origin)
				trace.op = op
				trace.succeeded = errors.length === 0
				// Applied in memory and never saved, so the caller sees the app-shaped
				// consequence BEFORE consenting to it — the same fold `workbench
				// {section:"blast-radius"}` does for a pending proposal, on the path an
				// agent is already standing on.
				const after = errors.length ? null : projectOp(spec, ctx, op)
				const effect = after ? opEffect(spec, after, op) : null
				if (effect) trace.effect = effect
				return ok({
					valid: errors.length === 0,
					errors,
					diff: errors.length ? null : diffOp(op),
					effect,
				})
			}

			// The `await`s are load-bearing: `return promise` inside a try does NOT
			// route the promise's rejection through this catch, so a save-time throw
			// escaped as a raw HTTP 500.
			case 'apply_spec_change':
				return await applyAndSave(ctx, spec, toSpecOp(args), trace)

			case 'record_decision':
				return await applyAndSave(ctx, spec, decisionOp(ctx, args), trace)

			case 'report_defect': {
				const report: DefectReport = {
					title: args.title as string,
					surface: args.surface as string,
					severity: args.severity as string,
					what: args.what as string,
					expected: args.expected as string,
					actual: args.actual as string,
					workaround:
						typeof args.workaround === 'string' ? args.workaround : undefined,
					reportedAt: ctx.now(),
					origin: ctx.origin,
				}
				// No sink is not a refusal. The tool's whole reason for existing is
				// that an agent with nowhere to put a defect puts it somewhere wrong,
				// so a host without a sink still gets a filled-in report back — and
				// is told, in the payload, that nothing was persisted.
				const where = await ctx.defects?.record(report)
				return ok({
					recorded: where !== undefined,
					where: where ?? null,
					report,
					note: where
						? `Recorded in ${where}. Your spec and your app are unchanged — this filed a report, nothing else.`
						: 'NOT persisted: this host has no defect sink wired. The report is returned here in full — carry it upstream yourself (file it against maxstack) rather than writing it into the decision ledger.',
				})
			}

			case 'run_generator': {
				if (typeof args.generator !== 'string')
					return err('run_generator: "generator" is required')
				const result = await ctx.generators.run(
					args.generator,
					spec,
					(args.args ?? {}) as Record<string, unknown>,
				)
				return ok(result)
			}

			case 'run_checks': {
				const requested = Array.isArray(args.checks)
					? (args.checks as unknown[]).filter(
							(c): c is string => typeof c === 'string',
						)
					: undefined
				const known = new Set(ctx.checks.list().map((c) => c.name))
				// A check this host declares it cannot run, plus any name the caller
				// asked for that does not exist here. Both are "went unexamined", and
				// both have to survive into the payload — see below.
				const unavailable: UnavailableCheck[] = [
					...((await ctx.checks.unavailable?.()) ?? []),
					...(requested ?? [])
						.filter((n) => !known.has(n))
						.map((n) => ({
							name: n,
							reason: `no check named "${n}" is registered on this host`,
							remedy: `Available here: ${[...known].join(', ') || '(none)'}.`,
						})),
				]
				const results = await ctx.checks.run(
					spec,
					requested?.filter((n) => known.has(n)),
				)
				const failed = results.filter((r) => !r.ok)
				// A check that never ran withholds the green — unless it had nothing
				// to examine. Both halves stay in the payload; only the
				// blocking ones move `status`, so a scaffold at op zero is not told
				// its own untouched code went unexamined.
				const blocking = unavailable.filter((u) => u.blocking !== false)
				const notApplicable = unavailable.filter((u) => u.blocking === false)
				// `ok` is true ONLY when everything that should have run did run and
				// passed. Agents treat `ok: true` as terminal — it is why
				// no typecheck ever happened — so a green that means "some of it
				// passed and the rest never executed" is worse than a red. This is the
				// same house rule `workbench` follows with its `unavailable` list and
				// its refusal to say "nothing needs you".
				const status =
					failed.length > 0
						? 'fail'
						: blocking.length > 0
							? 'incomplete'
							: 'pass'
				const passSuffix = notApplicable.length
					? ` ${notApplicable.length} check(s) did not apply here (${notApplicable
							.map((u) => u.name)
							.join(', ')}) — see \`unavailable\` for why.`
					: ''
				return ok({
					ok: status === 'pass',
					status,
					ran: results.map((r) => r.name),
					results,
					unavailable,
					headline:
						status === 'pass'
							? `All ${results.length} check(s) ran and passed.${passSuffix}`
							: status === 'fail'
								? `${failed.length} of ${results.length} check(s) failed: ${failed.map((r) => r.name).join(', ')}.`
								: `${results.length} check(s) passed, but ${blocking.length} never ran (${blocking.map((u) => u.name).join(', ')}). This is NOT a green — that code is unexamined.`,
				})
			}

			case 'explain_feature':
				return ok(explain(spec, args))

			case 'list_acceptance_criteria':
				return ok(acceptanceCriteria(spec, args))

			default:
				return err(`Unknown platform tool: ${name}`)
		}
	} catch (e) {
		return platformFail(e, { resource: 'spec', operation: name }, exposure)
	}
}
