/**
 * `maxstack op [dir|file] --file <op.json>` — apply a typed spec-op to the
 * project's spec, the same primitive an agent drives over MCP (`applyOp`:
 * validate, then land, never mutating in place). The op JSON is
 * `{ "op": "...", "args": {...} }`; read from `--file`, `--op '<json>'`, a
 * positional file path (`maxstack op op.json`), or piped stdin.
 *
 * `--accept` and `--gen` collapse the trusted-solo happy path:
 * land + auto-accept + regenerate in one shot, instead of op → workbench
 * Accept → gen. A project with `"reviewMode": "auto"` in `maxstack.json` gets
 * both implicitly; explicit flags always win.
 */

import type { SpecOp } from '@maxstack/spec'
import { landOp, landSummary } from '../lib/land.ts'
import { resolveActor, resolveOrigin } from '../lib/origin.ts'
import { loadProject } from '../lib/project.ts'

interface OpOptions {
	file?: string
	op?: string
	accept?: boolean
	gen?: boolean
	/** `--origin ai|human`; unset means "detect". */
	origin?: string
	/** `--agent <name>`; unset means "detect, else absent". */
	agent?: string
}

export async function opCommand(
	dir: string | undefined,
	opts: OpOptions,
): Promise<void> {
	// `maxstack op <file>` is the obvious shape, but `<file>` lands in the `[dir]`
	// positional. When that positional actually points at a file, treat it as the
	// op source (unless --file/--op already gave one) so it doesn't get read as a
	// project dir and then fall through to a stdin that hangs.
	if (dir && dir !== '.' && !opts.file && !opts.op) {
		const { stat } = await import('node:fs/promises')
		const isFile = await stat(dir)
			.then((s) => s.isFile())
			.catch(() => false)
		if (isFile) {
			opts = { ...opts, file: dir }
			dir = '.'
		}
	}

	const raw = await readOpSource(opts)
	let parsed: SpecOp
	try {
		parsed = JSON.parse(raw) as SpecOp
	} catch (err) {
		throw new Error(`invalid op JSON: ${(err as Error).message}`)
	}
	if (!parsed || typeof parsed.op !== 'string') {
		throw new Error('op JSON must be { "op": "<name>", "args": { ... } }')
	}

	const project = await loadProject(dir ?? '.')
	const auto = project.config.reviewMode === 'auto'
	const accept = opts.accept ?? auto
	const gen = opts.gen ?? auto

	const result = await landOp(project, parsed, {
		accept,
		gen,
		origin: resolveOrigin(opts.origin),
		actor: resolveActor({ path: 'cli-op', agent: opts.agent }),
	})

	console.log(`✔ applied ${parsed.op}`)
	console.log(landSummary(result))
}

async function readOpSource(opts: OpOptions): Promise<string> {
	if (opts.op) return opts.op
	if (opts.file) {
		const { readFile } = await import('node:fs/promises')
		return readFile(opts.file, 'utf8')
	}
	// stdin fallback: `echo '{...}' | maxstack op`. Only when stdin is actually
	// piped — on an interactive terminal there's nothing to read, so fail fast
	// with the usage hint instead of blocking forever on `for await`.
	if (process.stdin.isTTY) {
		throw new Error(
			'no op provided — pass a file (`maxstack op <op.json>`), --op <json>, or pipe stdin',
		)
	}
	const chunks: Buffer[] = []
	for await (const chunk of process.stdin) chunks.push(chunk as Buffer)
	const stdin = Buffer.concat(chunks).toString('utf8').trim()
	if (!stdin) {
		throw new Error(
			'no op provided — pass --file <op.json>, --op <json>, or pipe stdin',
		)
	}
	return stdin
}
