/**
 * maxstack — the AI-native app platform CLI: the **command tree**.
 *
 * Split out of `cli.ts` (which is now just the bin entry that parses argv) so
 * the tree is a value anything can read without executing the CLI. That is what
 * makes `docs/cli-reference.md` generated rather than hand-maintained:
 * `scripts/gen-reference-docs.ts` calls {@link buildProgram} and walks the
 * commander metadata, so a new verb or flag documents itself and the drift
 * check in the validate gate fails any PR that adds one without regenerating.
 *
 * The verbs, each remapped onto the shipped primitives:
 *
 *       start <desc> a sentence in, a running populated app out
 *       init [dir]   scaffold a standalone maxstack project (spec + app + gate)
 *       gen [dir]    regenerate the app tree through the never-clobber writer
 *       upgrade [dir] migrate installed bundles through their codemods, then
 *                    regenerate — the same action as `gen --upgrade`
 *       op [dir]     apply a typed spec-op to the spec (validate then land)
 *       add-entity   terminal-native sugar → a data.addEntity op
 *       add-field    terminal-native sugar → a data.addField op
 *       add-page     terminal-native sugar → a page.addPage op
 *       theme        terminal-native sugar → a theme.set op
 *       add <bundle> install a feature bundle (schema + pages + seeds + DI)
 *       add view <p> scaffold one page's owned list view (inferred, then ejected)
 *       eject <id>   take ownership of a generated route (never re-clobbered)
 *       drift        what you own, and how far it has drifted from the derivation
 *       review       the queue, risk classification, and the coherent overview
 *       slots        where bespoke UI can go without ejecting
 *       doctor       report what is actually running: versions, runtime, store
 *                    lock, dev server, MCP handshake
 *       validate     the standalone gate (spec valid · manifest intact · regen safe)
 *       dev [dir]    run the platform web app over the project data dir
 *       demo [dir]   load sample data into the project
 *       build [dir]  vendor a portable deployable runtime + build a Docker image
 *       deploy [dir] ship the vendored runtime (local docker run, or Fly)
 *
 * A few commands are registered but hidden from `--help`. They are not
 * deprecated — they are the ones nothing types by hand: `mcp` is spawned by
 * agent clients through the generated `.mcp.json`, `guard-edit` is a
 * PreToolUse hook fed events on stdin, `runtime` is for debugging a local
 * checkout, and the two cost reports only produce output on a project that
 * opted into review telemetry. Hiding them keeps the help output the list of
 * things a person actually chooses between.
 */
import { Command } from 'commander'
import { addCommand, catalogCommand } from './commands/add.ts'
import {
	addEntityCommand,
	addFieldCommand,
	addPageCommand,
} from './commands/add-entity.ts'
import { buildCommand } from './commands/build.ts'
import { deployCommand } from './commands/deploy.ts'
import { demoCommand, devCommand } from './commands/dev.ts'
import { doctorCommand } from './commands/doctor.ts'
import { driftCommand } from './commands/drift.ts'
import { ejectCommand } from './commands/eject.ts'
import { genCommand } from './commands/gen.ts'
import { guardEditCommand } from './commands/guard.ts'
import { initCommand } from './commands/init.ts'
import { mcpCommand } from './commands/mcp.ts'
import { opCommand } from './commands/op.ts'
import { regenCostCommand } from './commands/regen-cost.ts'
import { reviewCommand } from './commands/review.ts'
import { reviewCostCommand } from './commands/review-cost.ts'
import {
	runtimeLinkCommand,
	runtimeStatusCommand,
	runtimeUnlinkCommand,
} from './commands/runtime.ts'
import { slotsCommand, slotsFillCommand } from './commands/slots.ts'
import { startCommand } from './commands/start.ts'
import { themeCommand } from './commands/theme.ts'
import { upgradeCommand } from './commands/upgrade.ts'
import { validateCommand } from './commands/validate.ts'
import { addViewCommand } from './commands/view.ts'
import { workbenchCommand } from './commands/workbench.ts'
import { interactionFor } from './lib/prompt.ts'

/** Collect a repeatable option (`--field a --field b`) into an array. */
function collect(value: string, previous: string[] = []): string[] {
	return previous.concat([value])
}

/** The CLI version — keep in sync with package.json (build.mjs asserts this). */
export const CLI_VERSION = '0.11.15'

/**
 * Build the full command tree.
 *
 * A factory rather than a module-level singleton: the doc generator and the
 * tests each want their own clean `Command` (commander mutates the instance
 * during parsing), and building it lazily keeps importing this module free of
 * side effects.
 */
export function buildProgram(): Command {
	const program = new Command()

	program
		.name('maxstack')
		.description('The AI-native app platform CLI.')
		.version(CLI_VERSION)

	program
		.command('init')
		.argument(
			'[dir]',
			'project directory (omit to be prompted for a name; defaults to ./<kebab-case-name>)',
		)
		.option('-d, --desc <description>', 'one-line product description')
		.option('--backend <backend>', 'store backend: pglite | postgres', 'pglite')
		.option(
			'--preflight-json',
			'emit the preflight diagnostics as JSON (for agents) instead of the human report',
		)
		.option(
			'--with <slugs>',
			'comma-separated feature bundles to install while scaffolding (prerequisites resolved and shown first)',
		)
		.option(
			'--dry-run',
			'with --with: preview what the selected modules would contribute; scaffold nothing',
		)
		.option(
			'--no-git',
			'skip `git init` and the scaffold commit (never-clobber then has no undo behind it)',
		)
		.description('Scaffold a standalone maxstack project (spec + app + gate)')
		.action((dir, opts) => initCommand(dir, opts))

	// The zero-friction entry: a sentence in, a populated clickable
	// app out. Declared right after `init` because it *is* `init` plus the three
	// steps a first-time user otherwise has to know to take.
	program
		.command('start')
		.argument('<description>', 'what you want built, in a sentence')
		.argument(
			'[dir]',
			'project directory (default: a kebab-case name derived from the description)',
		)
		.option('--port <port>', 'port to serve on (default: PORT env, then 3000)')
		.option('--backend <backend>', 'store backend: pglite | postgres', 'pglite')
		.option('--no-seed', 'skip the sample rows (start empty)')
		.option('--no-dev', 'stop after generating the app tree — do not serve')
		.description(
			'Scaffold, land the implied spec-ops, seed sample rows, and serve — in one command',
		)
		.action((description, dir, opts) => startCommand(description, dir, opts))

	// `gen` and `upgrade` were two verbs for one action: redraw the app tree
	// through the never-clobber writer. They differed only in which generators
	// they ran against — the pinned ones, or the current framework's. That is a
	// flag, not a second verb — and mechanically that still holds: `upgrade`
	// below is registered as an alias that calls the *same* `upgradeCommand`,
	// not a second code path.
	//
	// It exists anyway because discoverability is a different axis from
	// mechanical identity (#425). The bundle codemod chain is the structural
	// difference between a bundle and a starter kit, and a capability reachable
	// only as a flag on another verb has no name a reader searches for and no
	// line of its own in the reference. "Run `maxstack upgrade`" is a sentence;
	// "run `maxstack gen --upgrade`" is a footnote.
	program
		.command('gen')
		.argument('[dir]', 'project directory', '.')
		.option(
			'--upgrade',
			'migrate installed bundles through their registered codemods, then regenerate against the current framework generators',
		)
		.description('Regenerate the app tree from the spec (never-clobber)')
		.action((dir, opts) =>
			opts.upgrade === true ? upgradeCommand(dir) : genCommand(dir),
		)

	program
		.command('upgrade')
		.argument('[dir]', 'project directory', '.')
		.description(
			'Migrate installed bundles through their codemods, then regenerate against the current framework generators (same as "gen --upgrade")',
		)
		.action((dir) => upgradeCommand(dir))

	program
		.command('mcp', { hidden: true })
		.argument('[dir]', 'project directory', '.')
		.description(
			'Serve the MCP platform tools over stdio (spawned by agent clients via .mcp.json)',
		)
		.action((dir) => mcpCommand(dir))

	program
		.command('guard-edit', { hidden: true })
		.description(
			'PreToolUse hook: deny agent edits to generated files (reads the event on stdin)',
		)
		.action(() => guardEditCommand())

	program
		.command('op')
		.argument(
			'[dir|file]',
			'project directory, or an op JSON file to apply',
			'.',
		)
		.option('-f, --file <file>', 'op JSON file: { "op": "...", "args": {...} }')
		.option('--op <json>', 'inline op JSON')
		.option('--accept', 'auto-accept the change (clear the review queue)')
		.option('--gen', 'regenerate the app tree after landing')
		.option(
			'--origin <who>',
			'who authored this change: ai | human (default: detected, see MAXSTACK_ORIGIN)',
		)
		.option(
			'--agent <name>',
			'which agent authored it, for the audit trail (default: detected, see MAXSTACK_AGENT)',
		)
		.description('Apply a typed spec-op to the spec (validate then land)')
		.action((dir, opts) => opCommand(dir, opts))

	// --- Terminal-native sugar over raw op JSON --------------------

	program
		.command('add-entity')
		.argument(
			'[slug]',
			'entity id slug (lowercase, e.g. task -> e-task); omit at a terminal to be asked',
		)
		.argument('[dir]', 'project directory', '.')
		.option(
			'--field <spec>',
			"a field as name:type[!] (repeatable): title:text!, done:bool, 'priority:enum(low,high)', author:ref:e-user — quote any spec with ( or -> , they are shell syntax",
			collect,
			[],
		)
		.option('--name <name>', 'display name (default: title-cased slug)')
		.option(
			'--with-page',
			'also land a default list page for the entity in one shot',
		)
		.option('--route <route>', 'route for --with-page (default: /<slug>)')
		.option('--page-id <id>', 'page id for --with-page (default: pg-<slug>)')
		.option(
			'--page-name <name>',
			'page display name for --with-page (default: the entity name)',
		)
		.option('--accept', 'auto-accept the change (clear the review queue)')
		.option('--gen', 'regenerate the app tree after landing')
		.option(
			'--origin <who>',
			'who authored this change: ai | human (default: detected, see MAXSTACK_ORIGIN)',
		)
		.option(
			'--agent <name>',
			'which agent authored it, for the audit trail (default: detected, see MAXSTACK_AGENT)',
		)
		.description(
			'Add a data entity — sugar that compiles to a data.addEntity op',
		)
		.action((slug, dir, opts, cmd) =>
			addEntityCommand(dir, slug, opts, interactionFor(cmd)),
		)

	program
		.command('add-field')
		.argument(
			'[entity]',
			'target entity id or slug (e-task or task); omit at a terminal to be asked',
		)
		.argument(
			'[spec]',
			"the field as name:type[!] — dueOn:date!, 'status:enum(todo,done)', owner:ref:e-user (quote any spec with ( or ->). Omit at a terminal to be asked field-by-field, which needs no quoting",
		)
		.argument('[dir]', 'project directory', '.')
		.option('--accept', 'auto-accept the change (clear the review queue)')
		.option('--gen', 'regenerate the app tree after landing')
		.option(
			'--origin <who>',
			'who authored this change: ai | human (default: detected, see MAXSTACK_ORIGIN)',
		)
		.option(
			'--agent <name>',
			'which agent authored it, for the audit trail (default: detected, see MAXSTACK_AGENT)',
		)
		.description('Add a field to an entity — sugar for a data.addField op')
		.action((entity, spec, dir, opts, cmd) =>
			addFieldCommand(dir, entity, spec, opts, interactionFor(cmd)),
		)

	program
		.command('add-page')
		.argument(
			'[entity]',
			'target entity id or slug (e-task or task); omit at a terminal to be asked',
		)
		.argument('[dir]', 'project directory', '.')
		.option('--name <name>', 'page display name (default: title-cased slug)')
		.option('--route <route>', 'route path (default: /<slug>)')
		.option('--id <id>', 'page id (default: pg-<slug>)')
		.option('--accept', 'auto-accept the change (clear the review queue)')
		.option('--gen', 'regenerate the app tree after landing')
		.option(
			'--origin <who>',
			'who authored this change: ai | human (default: detected, see MAXSTACK_ORIGIN)',
		)
		.option(
			'--agent <name>',
			'which agent authored it, for the audit trail (default: detected, see MAXSTACK_AGENT)',
		)
		.description(
			'Add a default list page for an entity — sugar that compiles to a page.addPage op',
		)
		.action((entity, dir, opts, cmd) =>
			addPageCommand(dir, entity, opts, interactionFor(cmd)),
		)

	program
		.command('theme')
		.argument(
			'[preset]',
			'theme preset: zinc | ocean | forest | sunset | mono | rose | amber; omit at a terminal to be asked',
		)
		.argument('[dir]', 'project directory', '.')
		.option(
			'--accent <hex>',
			'accent color as #rgb/#rrggbb (overrides primary)',
		)
		.option('--radius <r>', 'corner rounding: sm | md | lg | full')
		.option('--density <d>', 'rendering density: comfortable | compact')
		.option(
			'--font <f>',
			'font stack: sans | serif | mono | rounded | humanist',
		)
		.option('--type-scale <s>', 'type scale: compact | default | relaxed')
		.option(
			'--origin <who>',
			'who authored this change: ai | human (default: detected, see MAXSTACK_ORIGIN)',
		)
		.option(
			'--agent <name>',
			'which agent authored it, for the audit trail (default: detected, see MAXSTACK_AGENT)',
		)
		.description(
			"Set the app's visual theme — sugar that compiles to a theme.set op (live immediately)",
		)
		.action((preset, dir, opts, cmd) =>
			themeCommand(dir, preset, opts, interactionFor(cmd)),
		)

	program
		.command('add')
		.argument(
			'[target]',
			'feature bundle slug (auth, members, audit, ...), or "view" to scaffold a page view. Omit to browse the catalog.',
		)
		.argument(
			'[arg2]',
			'for "add view": the page to scaffold — its route path, page id or module key, or a resource with exactly one page; otherwise the project directory',
		)
		.argument('[dir]', 'for "add view": the project directory', '.')
		.option(
			'--dry-run',
			'preview the spec diff the install would produce; write nothing',
		)
		.option(
			'--force',
			'for "add view": overwrite the view module even though you own it (destroys your edits)',
		)
		.description(
			'Browse the catalog (no argument), install a feature bundle, or "add view <page>" to scaffold an owned list view',
		)
		.action((target, arg2, dir, opts, cmd) => {
			// No argument is the discovery surface: a catalog nobody
			// can browse markets as breadth and delivers as trivia.
			if (!target) return catalogCommand(arg2 ?? '.', interactionFor(cmd))
			if (target === 'view') {
				if (!arg2)
					throw new Error(
						'usage: maxstack add view <page> [dir]\n' +
							'  <page> is a route path, page id or module key — or a resource,\n' +
							'  when exactly one page renders it.',
					)
				return addViewCommand(dir, arg2, { force: opts.force === true })
			}
			return addCommand(arg2 ?? '.', target, { dryRun: opts.dryRun === true })
		})

	program
		.command('eject')
		.argument(
			'[route-id]',
			'route id to take ownership of; omit at a terminal to be asked',
		)
		.argument('[dir]', 'project directory', '.')
		.option('--to <file>', 'destination file (default: in place)')
		.option(
			'--dry-run',
			'preview the file that would be ejected; write nothing',
		)
		.description('Take ownership of a generated route (never re-clobbered)')
		.action((routeId, dir, opts, cmd) =>
			ejectCommand(dir, routeId, opts, interactionFor(cmd)),
		)

	program
		.command('drift')
		.argument('[dir]', 'project directory', '.')
		.option('--patches', 'print the unified diff for every drifted file')
		.option('--json', 'emit the report as JSON')
		.description(
			'What you own, what it was derived from, and how far it has drifted (never writes)',
		)
		.action((dir, opts) => driftCommand(dir, opts))

	// The review queue and bulk decisions. Present in the CLI because
	// an agent driving a long unattended session is exactly what produces forty
	// pending proposals, and a queue only a human with a browser can clear is a
	// queue that stays full. Deliberately no --all and no --force: the
	// risk model refuses a dangerous proposal a place in a batch, and a flag that
	// overrode that would make the classification decorative.
	program
		.command('review')
		.argument('[dir]', 'project directory', '.')
		.option('--json', 'emit the queue + risk assessments as JSON')
		.option(
			'--accept <selector>',
			'accept a group ("field:e-order") or one proposal ("fld-total"), comma-separated',
		)
		.option('--reject <selector>', 'reject, same selector grammar as --accept')
		.option(
			'--undo <batchId>',
			'return every row that batch settled to undecided',
		)
		.option(
			'--origin <who>',
			'who authored this change: ai | human (default: detected, see MAXSTACK_ORIGIN)',
		)
		.option(
			'--agent <name>',
			'which agent authored it, for the audit trail (default: detected, see MAXSTACK_AGENT)',
		)
		.option(
			'--section <name>',
			'"exposure" (what is publicly reachable, and what is one op away) or "blast-radius" (what accepting everything pending does to the built app); omit for the ordered what-needs-you list',
		)
		.description(
			'What needs you, in order — worst first, with the reason why, plus bulk accept/reject and undo',
		)
		.action((dir, opts) =>
			// `workbench` and `review` were the same question asked twice: what
			// needs a decision, and why. The overview is what you get with no
			// selector; naming a section narrows it. Reaching either through one
			// verb is why neither has to be discovered separately.
			opts.accept === undefined &&
			opts.reject === undefined &&
			opts.undo === undefined
				? workbenchCommand(dir, opts)
				: reviewCommand(dir, opts),
		)

	// The human half of the north-star metric. Present in the CLI as
	// well as the workbench because a number only a browser can show is a number
	// #168's comparison cannot consume — the agent is a primary
	// interface, and the workbench must never be the only path).
	program
		.command('review-cost', { hidden: true })
		.argument('[dir]', 'project directory', '.')
		.option(
			'--json',
			'emit the full report as JSON (summary, decisions, curve)',
		)
		.option(
			'--idle-cutoff <seconds>',
			're-derive engaged time with a different idle cutoff (default 120) — the parameter exists so the number can be rechecked, not tuned',
		)
		.description(
			'What approving a change costs you: engaged time per proposal, separate from wall clock (opt-in)',
		)
		.action((dir, opts) => reviewCostCommand(dir, opts))

	// The platform half of the same question. `review-cost` says what
	// a change costs the maintainer; this says what it costs the project. Named
	// for what it measures — files redrawn per op — and never for
	// `weightPerSafeChange`, which needs a replay of *attempted* changes that no
	// user's project records.
	program
		.command('regen-cost', { hidden: true })
		.argument('[dir]', 'project directory', '.')
		.option('--json', 'emit the full report as JSON (points, trend, totals)')
		.description(
			'Whether this project is getting harder to change: files regenerated per op, over time',
		)
		.action((dir, opts) => regenCostCommand(dir, opts))

	const slots = program
		.command('slots')
		.argument('[dir]', 'project directory', '.')
		.option('--json', 'emit the inventory as JSON')
		.description(
			'List every place bespoke UI can go without ejecting, and which are filled',
		)
		.action((dir, opts) => slotsCommand(dir, opts))

	slots
		.command('fill')
		.argument(
			'[id]',
			'slot id, as printed by `maxstack slots`; omit at a terminal to be asked',
		)
		.argument('[dir]', 'project directory', '.')
		.description('Scaffold a typed, user-owned stub for one block slot')
		.action((id, dir, _opts, cmd) =>
			slotsFillCommand(id, dir, interactionFor(cmd)),
		)

	program
		.command('validate')
		.argument('[dir]', 'project directory', '.')
		.description(
			'The standalone gate: spec valid · manifest intact · regen safe',
		)
		.action((dir) => validateCommand(dir))

	program
		.command('doctor')
		.argument('[dir]', 'project directory', '.')
		.option('--offline', 'skip the npm registry staleness probe')
		.option('--no-mcp-probe', 'skip the MCP stdio handshake (spawns a process)')
		.option('--json', 'emit the findings as JSON')
		.description(
			'Report what is actually running: CLI/runtime versions, staleness, store lock, dev server, MCP reachability',
		)
		.action((dir, opts) =>
			doctorCommand(dir, {
				offline: opts.offline,
				// commander maps `--no-mcp-probe` to `opts.mcpProbe === false`.
				noMcpProbe: opts.mcpProbe === false,
				json: opts.json,
			}),
		)

	// --- Local runtime override -----------------------------------

	const runtime = program
		.command('runtime', { hidden: true })
		.description(
			'Run this project against a local maxstack checkout (contributor debugging)',
		)

	runtime
		.command('link')
		.argument(
			'<path>',
			'path to a maxstack checkout (the dir holding apps/web)',
		)
		.argument('[dir]', 'project directory', '.')
		.description(
			'Serve this project from a local checkout instead of the installed runtime',
		)
		.action((path, dir) => runtimeLinkCommand(dir, path))

	runtime
		.command('unlink')
		.argument('[dir]', 'project directory', '.')
		.description('Drop the link and go back to the installed runtime')
		.action((dir) => runtimeUnlinkCommand(dir))

	runtime
		.command('status')
		.argument('[dir]', 'project directory', '.')
		.description('Show which runtime this project resolves to, and why')
		.action((dir) => runtimeStatusCommand(dir))

	program
		.command('dev')
		.argument('[dir]', 'project directory', '.')
		.option(
			'--owned',
			'force the owned-code dev server (auto-selected when owned modules exist): vendors + installs the runtime source once, then runs its dev server (needs pnpm)',
		)
		.option('--port <port>', 'port to serve on (default: PORT env, then 3000)')
		.option(
			'--preflight-json',
			'emit the preflight diagnostics as JSON (for agents) instead of the human report',
		)
		.description('Run the platform web app over the project data dir')
		.action((dir, opts) => devCommand(dir, opts))

	program
		.command('demo')
		.argument('[dir]', 'project directory', '.')
		.option(
			'--port <port>',
			'port a running `maxstack dev` is on (default: PORT env, then the port `maxstack dev` recorded, then 3000)',
		)
		.option(
			'--clear',
			'remove the rows a previous seed created, leaving your own data alone',
		)
		.description(
			'Load sample data into the project so there is something to explore',
		)
		.action((dir, opts) => demoCommand(dir, opts))

	program
		.command('build')
		.argument('[dir]', 'project directory', '.')
		.option('--image <tag>', 'docker image tag (default maxstack-<name>)')
		.option(
			'--vendor-only',
			'produce the portable tree only; skip the image build',
		)
		.description(
			'Vendor a portable deployable runtime (owned code compiled in) + build an image',
		)
		.action((dir, opts) => buildCommand(dir, opts))

	program
		.command('deploy')
		.argument('[dir]', 'project directory', '.')
		.option('--target <target>', 'docker (local run) or fly', 'docker')
		.option('--port <port>', 'host port for the local docker run', '3000')
		.option('--image <tag>', 'docker image tag (default maxstack-<name>)')
		.option('--execute', 'for --target fly: actually run `fly deploy`')
		.description('Ship the vendored runtime (local docker run, or Fly)')
		.action((dir, opts) => deployCommand(dir, opts))

	return program
}
