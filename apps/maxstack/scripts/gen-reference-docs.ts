/**
 * Generate the four **reference** docs from their source of truth (
 * extended by #182).
 *
 *   docs/cli-reference.md    ← the commander tree in `src/program.ts`
 *   docs/spec-ops.md         ← `SPEC_OP_VOCABULARY` in @maxstack/spec
 *   docs/mcp-reference.md    ← `platformTools()` in @maxstack/mcp
 *   docs/bundle-reference.md ← `BUNDLES` + `BUNDLE_CODEMODS` in @maxstack/features
 *
 * Reference material is exactly the genre that rots when hand-maintained: a new
 * `--flag` or a new op is a one-line change in the source and a change nobody
 * remembers to mirror in prose. So these three are generated, marked
 * do-not-edit, and guarded — `--check` re-renders in memory and diffs against
 * the tree, and the validate gate runs it, so a PR that adds a verb without
 * regenerating goes red instead of shipping a lie.
 *
 * The *narrative* docs (user-guide, quickstart, ownership, …) stay hand-written;
 * only the enumerable surfaces are machine-rendered.
 *
 *   node --experimental-transform-types scripts/gen-reference-docs.ts
 *   node --experimental-transform-types scripts/gen-reference-docs.ts --check
 */

import { readFile, writeFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import {
	BUNDLE_CODEMODS,
	type Bundle,
	bundleFootprint,
	listBundles,
} from '@maxstack/features/bundle'
import { hostGate, platformTools } from '@maxstack/mcp'
import {
	type OpArgProperty,
	type OpArgSchema,
	SPEC_OP_NAMES,
	SPEC_OP_VOCABULARY,
	type SpecOpName,
} from '@maxstack/spec'
import type { Command, Option } from 'commander'
import { buildProgram, CLI_VERSION } from '../src/program.ts'
import { docContext } from './mcp-doc-context.ts'

const appDir = resolve(fileURLToPath(new URL('..', import.meta.url)))
const docsDir = resolve(appDir, '../../docs')

const check = process.argv.includes('--check')

// ===========================================================================
// Shared rendering helpers
// ===========================================================================

const BANNER = (source: string) =>
	`<!-- GENERATED FILE — DO NOT EDIT BY HAND.
     Source: ${source}
     Regenerate: pnpm docs:reference   (the validate gate checks this is current) -->`

/** Escape the characters that would break a markdown table cell. */
function cell(text: string | undefined): string {
	if (!text) return '—'
	return text.replace(/\|/g, '\\|').replace(/\n+/g, ' ').trim()
}

/** Wrap in backticks, escaping any pipe — for use *inside a markdown table*. */
function code(text: string): string {
	return `\`${text}\``.replace(/\|/g, '\\|')
}

/**
 * Wrap in backticks with no escaping — for prose and bullets. CommonMark does
 * not process backslash escapes inside a code span, so escaping here would
 * render a literal `\|` to the reader.
 */
function lit(text: string): string {
	return `\`${text}\``
}

// ===========================================================================
// docs/cli-reference.md
// ===========================================================================

/**
 * How the verbs are grouped in the doc. Grouping is editorial — it is the one
 * thing the commander tree cannot tell us — so it lives here, and any verb
 * missing from it makes the generator throw rather than silently vanish from
 * the reference.
 */
const CLI_GROUPS: { title: string; blurb: string; commands: string[] }[] = [
	{
		title: 'Starting and running a project',
		blurb:
			'`start` is the one-command entry: a description in, a populated app ' +
			'serving on localhost out. `init` is the same scaffold without the ' +
			'starting spec, the sample rows, or the server. After that it is the ' +
			'everyday loop: regenerate, serve, and check.',
		commands: ['start', 'init', 'gen', 'dev', 'demo', 'validate', 'doctor'],
	},
	{
		title: 'Changing the spec',
		blurb:
			'Every one of these lands a typed [spec-op](spec-ops.md). `op` takes the raw ' +
			'JSON; the rest are terminal-native sugar that compile to exactly the same ' +
			'thing, so anything you can do here you can also do over [MCP](mcp-reference.md).',
		commands: ['op', 'add-entity', 'add-field', 'add-page', 'theme', 'add'],
	},
	{
		title: 'Owning generated code',
		blurb:
			'The lower rungs of the [change ladder](user-guide.md#5-making-a-change) — ' +
			'see [`ownership.md`](ownership.md) for what the manifest guarantees. ' +
			'`slots` comes before `eject`: it lists every region you can take over ' +
			'*without* owning a whole file, so bespoke UI costs one component ' +
			'instead of a surface (see [`block-slots.md`](block-slots.md)). ' +
			'`upgrade` (identically, `gen --upgrade`) is what makes an installed bundle ' +
			'different from a starter kit: it walks every installed bundle forward ' +
			'through its registered codemods — each an idempotent spec-op transform — and *then* ' +
			'regenerates against the current framework generators, through the same ' +
			'never-clobber writer, so a file you took ownership of is left where it ' +
			'is (see [`upgrades.md`](upgrades.md)). ' +
			'`drift` is the other half of the eject bargain: it reports what you own, ' +
			'what it was derived from, and how far it has fallen behind — and never ' +
			'writes anything (see [`upgrade-safety.md`](upgrade-safety.md)).',
		commands: ['slots', 'eject', 'upgrade', 'drift'],
	},
	{
		title: 'Reviewing and measuring',
		blurb:
			'The review loop and its cost, in the terminal rather than only in the ' +
			'workbench. `review` is the entry point: **what needs you, in order**, ' +
			'worst first \u2014 public exposure that would change, then anything that ' +
			'would stop existing, then proposals that cannot be batched, then drift, ' +
			'then the routine majority as one line. Its `--section exposure` answers ' +
			'"what of mine is on the internet", and `--section blast-radius` answers ' +
			'"what does accepting this actually do to the built app" \u2014 which ' +
			'tables, routes, forms and REST payloads move (see ' +
			'[`workbench.md`](workbench.md)). `review` prints the queue with a conservative risk ' +
			'classification and clears the safe groups in one action \u2014 it will not ' +
			'batch anything touching access, public exposure or a file you own, at any ' +
			'size (see [`bulk-review.md`](bulk-review.md)). `review-cost` is the ' +
			'*human* half of the north-star metric: ' +
			'how much attention approving a change actually takes, separated from ' +
			'wall-clock time and reported per proposal rather than per decision (see ' +
			'[`workbench.md`](workbench.md)). Opt-in — it is telemetry about your ' +
			'own reviewing, so it measures nothing until you ask it to. ' +
			'`regen-cost` is the *platform* half of the same question: how many files ' +
			'a regeneration redraws per op that landed, over time, so a project ' +
			'getting harder to change shows up as a number climbing. It is a proxy ' +
			'and says so — it is deliberately **not** the platform’s own ' +
			'`weightPerSafeChange`, which needs a replay of *attempted* changes that ' +
			'no project records.',
		commands: ['review', 'review-cost', 'regen-cost'],
	},
	{
		title: 'Shipping',
		blurb:
			'Vendor a portable runtime, then run it. See [`deploy.md`](deploy.md).',
		commands: ['build', 'deploy'],
	},
	{
		title: 'Agent and contributor tooling',
		blurb:
			'`mcp` and `guard-edit` are wired into the scaffolded project for you — ' +
			'you rarely type them.',
		commands: ['mcp', 'guard-edit', 'runtime'],
	},
]

/** `maxstack add-entity <slug> [dir]` — the usage line for one command. */
function usage(cmd: Command, prefix: string): string {
	const parts = [prefix, cmd.name()]
	if (cmd.options.length > 0) parts.push('[options]')
	for (const arg of cmd.registeredArguments) {
		parts.push(arg.required ? `<${arg.name()}>` : `[${arg.name()}]`)
	}
	if (cmd.commands.length > 0) parts.push('<subcommand>')
	return parts.join(' ')
}

function renderOptionRow(opt: Option): string {
	const def =
		opt.defaultValue === undefined ||
		(Array.isArray(opt.defaultValue) && opt.defaultValue.length === 0)
			? '—'
			: code(JSON.stringify(opt.defaultValue))
	return `| ${code(opt.flags)} | ${cell(opt.description)} | ${def} |`
}

function renderCommand(cmd: Command, prefix: string, depth: number): string {
	const heading = '#'.repeat(depth)
	const out: string[] = [
		`${heading} ${code(`${prefix} ${cmd.name()}`)}`,
		'',
		cmd.description(),
		'',
		'```sh',
		usage(cmd, prefix),
		'```',
		'',
	]

	if (cmd.registeredArguments.length > 0) {
		out.push('| Argument | Required | Default | Meaning |')
		out.push('| --- | --- | --- | --- |')
		for (const arg of cmd.registeredArguments) {
			const def =
				arg.defaultValue === undefined ? '—' : code(String(arg.defaultValue))
			out.push(
				`| ${code(arg.name())} | ${arg.required ? 'yes' : 'no'} | ${def} | ${cell(arg.description)} |`,
			)
		}
		out.push('')
	}

	if (cmd.options.length > 0) {
		out.push('| Option | Meaning | Default |')
		out.push('| --- | --- | --- |')
		for (const opt of cmd.options) out.push(renderOptionRow(opt))
		out.push('')
	}

	for (const sub of cmd.commands) {
		out.push(renderCommand(sub, `${prefix} ${cmd.name()}`, depth + 1))
	}

	return out.join('\n')
}

function renderCliReference(): string {
	const program = buildProgram()
	const byName = new Map(program.commands.map((c) => [c.name(), c]))

	// Fail loudly on a verb nobody filed — better a red gate than a silent hole.
	const grouped = new Set(CLI_GROUPS.flatMap((g) => g.commands))
	const ungrouped = [...byName.keys()].filter(
		(n) => !grouped.has(n) && n !== 'help',
	)
	if (ungrouped.length > 0) {
		throw new Error(
			`cli-reference: ${ungrouped.join(', ')} not filed under any group in CLI_GROUPS ` +
				`(scripts/gen-reference-docs.ts) — add them so they appear in the docs.`,
		)
	}

	const out: string[] = [
		BANNER('the commander tree in `apps/maxstack/src/program.ts`'),
		'',
		'# CLI reference',
		'',
		`Every \`maxstack\` verb, rendered from the command tree itself (CLI v${CLI_VERSION}).`,
		'',
		'This is the **consult** doc — it tells you what a flag does, not when to',
		'reach for it. For the narrative, start with [`quickstart.md`](quickstart.md)',
		'and then [`user-guide.md`](user-guide.md).',
		'',
		'## Conventions',
		'',
		'- **`[dir]` defaults to `.`** on every platform verb, so run them from the',
		'  project root and omit it.',
		'- **Every write verb takes `--origin`.** It records *who authored the change*',
		'  (person vs agent) on the op-log entry, not which wire carried it. Resolution',
		'  order: `--origin` → `MAXSTACK_ORIGIN` → agent-environment detection',
		'  (`CLAUDECODE`, `CLAUDE_CODE_ENTRYPOINT`) → `human`.',
		'- **`--accept` skips the review queue.** Without it a spec change lands as a',
		'  *suggestion* awaiting accept/reject in `/workbench`; with it the row lands',
		'  already accepted.',
		'- **`--gen` regenerates after landing.** Spec-ops change the spec; code appears',
		'  when the tree is regenerated (a running `maxstack dev` does it for you).',
		'- **Exit codes are binary**: `0` on success, `1` with a `✖ <message>` line on',
		'  stderr for any failure. There are no other codes to branch on.',
		'',
		'## Environment',
		'',
		'| Variable | Read by | Effect |',
		'| --- | --- | --- |',
		'| `MAXSTACK_ORIGIN` | every write verb | `ai` \\| `human` — overrides origin detection. Not read by `mcp`, where the transport already settles it. |',
		'| `MAXSTACK_AGENT` | every write verb, `mcp` | Which agent authored the change, for the audit trail. Overridden by `--agent`. |',
		'| `MAXSTACK_SESSION` | every write verb, `mcp` | Opaque id grouping one agent run, so a batch of ops reviews as one piece of work. |',
		'| `MAXSTACK_KEY_ID` | every write verb, `mcp` | The api-key row id that authorized the change — never the secret. |',
		'| `MAXSTACK_DATA_DIR` | `dev`, `demo` | Durable runtime state dir for the project. |',
		'| `PORT` | `dev`, `demo`, `deploy` | Default port when `--port` is absent. |',
		'| `DATABASE_URL` | `dev`, `build` | Postgres connection when the backend is `postgres`. |',
		'| `CLAUDECODE`, `CLAUDE_CODE_ENTRYPOINT` | origin detection | Presence means an agent is driving; origin becomes `ai`. |',
		'| `NO_COLOR` | all output | Suppresses ANSI colour. |',
		'',
	]

	for (const group of CLI_GROUPS) {
		out.push(`## ${group.title}`, '', group.blurb, '')
		for (const name of group.commands) {
			const cmd = byName.get(name)
			if (!cmd) {
				throw new Error(
					`cli-reference: CLI_GROUPS lists "${name}" but the program has no such command.`,
				)
			}
			out.push(renderCommand(cmd, 'maxstack', 3))
		}
	}

	return `${out.join('\n').trimEnd()}\n`
}

// ===========================================================================
// docs/spec-ops.md
// ===========================================================================

/** Render one JSON-Schema arg node as an indented markdown bullet subtree. */
function renderArgProp(
	name: string,
	prop: OpArgProperty,
	required: boolean,
	indent: number,
): string[] {
	const pad = '  '.repeat(indent)
	const type = Array.isArray(prop.type)
		? prop.type.join(' | ')
		: (prop.type ?? 'any')
	const bits = [`${pad}- ${lit(name)} — ${lit(type)}`]
	if (required) bits.push('**required**')
	if (prop.enum) bits.push(`one of ${prop.enum.map(lit).join(', ')}`)
	if (prop.description) bits.push(prop.description)

	const lines = [bits.join(' · ')]

	const nested = prop.properties ?? prop.items?.properties
	const nestedRequired = new Set(prop.required ?? prop.items?.required ?? [])
	if (nested) {
		// `items.properties` means "each element of the array looks like this".
		if (!prop.properties) lines.push(`${pad}  each item:`)
		for (const [k, v] of Object.entries(nested)) {
			lines.push(...renderArgProp(k, v, nestedRequired.has(k), indent + 1))
		}
	} else if (prop.items?.oneOf) {
		const forms = prop.items.oneOf
			.map((o) =>
				lit(Array.isArray(o.type) ? o.type.join(' | ') : (o.type ?? '?')),
			)
			.join(' or ')
		lines.push(`${pad}  each item: ${forms}`)
	}
	return lines
}

function renderArgs(schema: OpArgSchema): string[] {
	const required = new Set(schema.required ?? [])
	const lines: string[] = []
	for (const [name, prop] of Object.entries(schema.properties)) {
		lines.push(...renderArgProp(name, prop, required.has(name), 0))
	}
	return lines
}

function renderSpecOps(): string {
	const byLayer = new Map<string, SpecOpName[]>()
	for (const name of SPEC_OP_NAMES) {
		const layer = SPEC_OP_VOCABULARY[name].layer
		byLayer.set(layer, [...(byLayer.get(layer) ?? []), name])
	}

	const out: string[] = [
		BANNER('`SPEC_OP_VOCABULARY` in `packages/spec/src/base/spec-ops.ts`'),
		'',
		'# Spec-op reference',
		'',
		`The ${SPEC_OP_NAMES.length} typed operations that can change a project spec — the whole`,
		'vocabulary. Nothing else writes to the spec: the CLI sugar, the MCP tools, and',
		'the workbench UI all compile down to these, which is what makes a change',
		'reviewable, attributable, and replayable.',
		'',
		'The same vocabulary is available **at runtime** to any agent, with these exact',
		'arg schemas, via `query_spec {section:"ops", ops:[…]}` — see',
		'[`mcp-reference.md`](mcp-reference.md). You should never have to guess an arg',
		'shape.',
		'',
		'## Applying one',
		'',
		'```sh',
		'# raw, from a file or inline',
		'maxstack op --op \'{"op":"data.addField","args":{...}}\' --accept --gen',
		'',
		'# or the sugar, which compiles to the same op',
		'maxstack add-field task dueOn:date! --accept --gen',
		'```',
		'',
		'Ops are **additive** except the four setters (`page.setBlockOrder`,',
		'`page.setBlockVariant`, `page.setBlockFields`, `theme.set`), which are',
		'last-wins replacements, and `provenance.review`, which decides existing rows.',
		'',
		'`provenance` is optional on every add-op and best **omitted** — the server',
		'stamps the correct default. Supplying it partially is an error; it is all five',
		'keys or nothing.',
		'',
		'## The vocabulary',
		'',
		'| Op | Layer | What it does |',
		'| --- | --- | --- |',
	]

	for (const name of SPEC_OP_NAMES) {
		const meta = SPEC_OP_VOCABULARY[name]
		const anchor = name.replace(/\./g, '').toLowerCase()
		out.push(
			`| [${code(name)}](#${anchor}) | ${code(meta.layer)} | ${cell(meta.summary)} |`,
		)
	}
	out.push('')

	for (const [layer, names] of byLayer) {
		out.push(`## Layer: ${layer}`, '')
		for (const name of names) {
			const meta = SPEC_OP_VOCABULARY[name]
			out.push(`### ${code(name)}`, '', meta.summary, '', '**Arguments**', '')
			out.push(...renderArgs(meta.args))
			out.push('')
		}
	}

	return `${out.join('\n').trimEnd()}\n`
}

// ===========================================================================
// docs/mcp-reference.md
// ===========================================================================

function renderSchemaProps(schema: unknown): string[] {
	const s = schema as {
		properties?: Record<string, OpArgProperty>
		required?: readonly string[]
	}
	if (!s.properties || Object.keys(s.properties).length === 0) {
		return ['_No arguments._']
	}
	const required = new Set(s.required ?? [])
	return Object.entries(s.properties).flatMap(([k, v]) =>
		renderArgProp(k, v, required.has(k), 0),
	)
}

function renderMcpReference(): string {
	const tools = platformTools(docContext())

	const out: string[] = [
		BANNER('`platformTools()` in `packages/mcp/src/tools.ts`'),
		'',
		'# MCP reference',
		'',
		`The ${tools.length} **platform tools** a spec-driving agent uses. They are the same`,
		'surface the CLI write verbs sit on, so an agent and a human are making',
		'genuinely the same changes — reviewed the same way, logged the same way.',
		'',
		'## Connecting',
		'',
		'`maxstack init` scaffolds a `.mcp.json` that registers the server over',
		'**stdio**, so the client spawns it and the tools are present in every session',
		'— no port, no ordering against `maxstack dev`:',
		'',
		'```json',
		'{ "mcpServers": { "maxstack": { "command": "maxstack", "args": ["mcp"] } } }',
		'```',
		'',
		'Tools then appear as `mcp__maxstack__<name>`. If they are absent (a session',
		'that started before the project existed, or a client without MCP), the',
		'sanctioned fallback is the CLI — `maxstack op`, `add-entity`, `add-field`,',
		'`add-page`, `theme` reach the identical op path. See',
		'[`cli-reference.md`](cli-reference.md).',
		'',
		'## The loop',
		'',
		'1. `query_spec` — read the project, including `{section:"ops"}` for the full',
		'   op vocabulary, and `{section:"ops", ops:[…]}` for the arg schemas of the',
		'   ops you name.',
		'2. `propose_spec_change` — validate + diff a typed op. **Never writes.**',
		'3. `apply_spec_change` — land it (re-validated server-side; rejects anything',
		'   that would break referential integrity).',
		'4. `run_generator` → `run_checks` — turn the spec change into code, then prove',
		'   the gate is green.',
		'',
		'Only `apply_spec_change` and `record_decision` mutate, and both go through the',
		'same validator, so a broken spec cannot land.',
		'',
		'## Tools',
		'',
	]

	const gated = tools.filter((t) => hostGate(t.name))
	if (gated.length > 0) {
		out.push(
			`${gated.length} of these are **host-gated**: they are present only when the host wired`,
			'the provider behind them, so a session may legitimately not see them. That is a',
			'fact about your host, not about the vocabulary — each says below what it needs.',
			'They were missing from this page entirely for a while, because it was',
			'generated against a context with no optional providers.',
			'',
		)
	}

	for (const tool of tools) {
		out.push(`### ${code(tool.name)}`, '', tool.description, '')
		const gate = hostGate(tool.name)
		if (gate) {
			out.push(
				`**Requires** ${code(`context.${gate.provider}`)} — ${gate.requires}.`,
				'',
			)
		}
		out.push('**Input**', '')
		out.push(...renderSchemaProps(tool.inputSchema))
		out.push('')
	}

	return `${out.join('\n').trimEnd()}\n`
}

// ===========================================================================
// docs/bundle-reference.md
// ===========================================================================

/** The heading for a bundle's section, and the anchor GitHub derives from it. */
const bundleHeading = (b: Bundle) => `${code(b.slug)} — ${b.title}`

/** GitHub's rule: lowercase, drop punctuation, spaces to hyphens. */
function anchor(heading: string): string {
	return heading
		.toLowerCase()
		.replace(/[^a-z0-9 -]/g, '')
		.replace(/ /g, '-')
}

/** The upgrade chain for one bundle, oldest step first. */
function codemodsFor(bundle: Bundle) {
	return BUNDLE_CODEMODS.filter((c) => c.slug === bundle.slug)
}

function renderBundle(bundle: Bundle): string {
	const fp = bundleFootprint(bundle)
	const out: string[] = [
		`### ${bundleHeading(bundle)}`,
		'',
		bundle.description,
		'',
		'| | |',
		'| --- | --- |',
		`| Version | ${code(bundle.version)} (first shipped ${code(bundle.initialVersion)}) |`,
		`| Prerequisites | ${bundle.prerequisites.length ? bundle.prerequisites.map(code).join(', ') : 'none'} |`,
		`| Entitlement | ${bundle.entitlement ? code(bundle.entitlement) : '—'} |`,
		`| Tables owned | ${fp.tables.length ? fp.tables.map(code).join(', ') : 'none'} |`,
		`| Routes owned | ${bundle.ownership.routes.length ? bundle.ownership.routes.map(code).join(', ') : 'none'} |`,
		`| Owned-code routes | ${(bundle.ownership.ownedRoutes ?? []).length ? (bundle.ownership.ownedRoutes ?? []).map(code).join(', ') : 'none'} |`,
		`| DI bindings | ${(bundle.runtime.diBindings ?? []).length ? (bundle.runtime.diBindings ?? []).map(code).join(', ') : 'none'} |`,
		`| Uninstall | ${bundle.uninstall.supported ? 'supported' : 'not supported'} |`,
		'',
	]

	out.push(
		bundle.uninstall.supported
			? `**Uninstall.** ${bundle.uninstall.notes ?? 'Supported.'}`
			: `**No uninstall.** ${bundle.uninstall.reason}`,
		'',
	)

	const steps = codemodsFor(bundle)
	out.push('**Upgrade path.**', '')
	if (steps.length === 0) {
		out.push(
			`Still at its first release (${lit(bundle.version)}) — nothing to migrate.`,
			'',
		)
	} else {
		out.push('| From | To | Migration |', '| --- | --- | --- |')
		for (const step of steps) {
			out.push(
				`| ${code(step.from)} | ${code(step.to)} | ${cell(step.description)} |`,
			)
		}
		out.push('')
	}

	out.push('**Eval asks.** The change asks this bundle is measured with:', '')
	for (const ask of bundle.evalAsks) {
		out.push(`- ${ask.ask} _(${ask.source}: ${ask.sourceRef})_`)
	}
	out.push('')

	return out.join('\n')
}

function renderBundleReference(): string {
	const bundles = listBundles()
	const userFacing = bundles.filter((b) => b.userFacing)

	const out: string[] = [
		BANNER(
			'`BUNDLES` in `packages/features/src/bundle/catalog.ts` + `BUNDLE_CODEMODS`',
		),
		'',
		'# Bundle reference',
		'',
		`The ${bundles.length} installable feature bundles — ${userFacing.length} user-facing capabilities`,
		`plus ${bundles.length - userFacing.length} pieces of plumbing that are catalog entries only because`,
		'their install record drives composition-root wiring.',
		'',
		'```sh',
		'maxstack add <slug>   # prerequisites first, each through the same spec-op path',
		'maxstack upgrade      # walk installed bundles forward through their codemods',
		'```',
		'',
		'## The contract',
		'',
		'Every entry below satisfies seven requirements, enforced in',
		'`packages/features/src/bundle/contract.test.ts` — not reviewed by eye:',
		'',
		'1. **Honest prerequisites**, proven by installing the bundle alone into a bare project.',
		'2. **A versioned upgrade codemod path** — an unbroken chain from first release to today,',
		'   so a project installed at any version can walk forward. This is the whole difference',
		'   from a starter kit, so it is a hard gate.',
		'3. **Its own eval artifacts** — a PRD fragment and at least one honestly-sourced change',
		'   ask, so a bundle’s cost is measured like everything else.',
		'4. **Idempotent install** that never clobbers what it previously wrote.',
		'5. **Uninstall, or a documented reason there is none.**',
		'6. **Generated reference docs** — this file, drift-checked in the validate gate.',
		'7. **A declared ownership footprint** (tables, page routes, and owned-code routes)',
		'   collision-checked at install',
		'   against everything already there.',
		'',
		'## Catalog',
		'',
		'| Bundle | Kind | Version | Prerequisites | What it gives you |',
		'| --- | --- | --- | --- | --- |',
	]

	for (const b of bundles) {
		out.push(
			`| [${code(b.slug)}](#${anchor(bundleHeading(b))}) ` +
				`| ${b.userFacing ? 'capability' : 'plumbing'} | ${code(b.version)} ` +
				`| ${b.prerequisites.length ? b.prerequisites.map(code).join(', ') : '—'} ` +
				`| ${cell(b.title)} |`,
		)
	}
	out.push('')

	out.push('## Bundles', '')
	for (const b of bundles) out.push(renderBundle(b))

	return `${out.join('\n').trimEnd()}\n`
}

// ===========================================================================
// Emit
// ===========================================================================

const OUTPUTS: { file: string; render: () => string }[] = [
	{ file: 'cli-reference.md', render: renderCliReference },
	{ file: 'spec-ops.md', render: renderSpecOps },
	{ file: 'mcp-reference.md', render: renderMcpReference },
	{ file: 'bundle-reference.md', render: renderBundleReference },
]

const stale: string[] = []
for (const { file, render } of OUTPUTS) {
	const path = resolve(docsDir, file)
	const next = render()
	if (check) {
		const current = await readFile(path, 'utf8').catch(() => null)
		if (current !== next) stale.push(`docs/${file}`)
	} else {
		await writeFile(path, next)
		console.log(`  wrote docs/${file}`)
	}
}

if (check) {
	if (stale.length > 0) {
		console.error(
			`\n✖ reference docs are stale: ${stale.join(', ')}\n` +
				`  Run \`pnpm docs:reference\` and commit the result.\n`,
		)
		process.exit(1)
	}
	console.log('✓ reference docs are current')
}
