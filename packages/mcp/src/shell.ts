/**
 * Shell-backed checks + generators — the seam that lets a project host register
 * its real build commands as MCP checks/generators, so `run_checks` /
 * `run_generator` drive the actual validate gate (`vp check`, `vp test`,
 * `tsx prd/validate.ts`) and codegen instead of only the pure, spec-derived
 * built-ins.
 *
 * Kept out of the default runners (which stay pure so tests need no subprocess);
 * the CLI / web wiring composes these in:
 *
 *   createCheckRegistry([
 *     specValidateCheck,
 *     shellCheck('typecheck', 'tsc --noEmit', 'vp check'),
 *     shellCheck('test', 'unit + e2e tests', 'vp test'),
 *   ])
 */

import { spawn } from 'node:child_process'
import type {
	Check,
	CheckResult,
	Generator,
	GeneratorResult,
	RegisteredCheck,
	RegisteredGenerator,
} from './context.ts'

export interface ShellOptions {
	/** Working directory for the command (defaults to the host's cwd). */
	cwd?: string
	/** Extra environment on top of the host's. */
	env?: Record<string, string>
}

interface ShellOutcome {
	code: number
	output: string
}

/** Run a command string through the shell, capturing merged stdout+stderr. */
export function runShell(
	command: string,
	opts: ShellOptions = {},
): Promise<ShellOutcome> {
	return new Promise((resolve, reject) => {
		const child = spawn(command, {
			cwd: opts.cwd,
			env: opts.env ? { ...process.env, ...opts.env } : process.env,
			shell: true,
		})
		let output = ''
		child.stdout?.on('data', (d) => {
			output += d
		})
		child.stderr?.on('data', (d) => {
			output += d
		})
		child.on('error', reject)
		child.on('close', (code) => resolve({ code: code ?? 1, output }))
	})
}

/**
 * A check that passes iff `command` exits 0. Its captured output is the
 * failure diagnostic surfaced through `run_checks`.
 */
export function shellCheck(
	name: string,
	summary: string,
	command: string,
	opts: ShellOptions = {},
): RegisteredCheck {
	const run: Check = async (): Promise<CheckResult> => {
		const { code, output } = await runShell(command, opts)
		return { name, ok: code === 0, output: output.trim() || `${name}: ok` }
	}
	return { name, summary, run }
}

/**
 * A generator whose artifacts a host command produces on disk. It runs the
 * command and reports its output as a note (the artifacts already landed in the
 * project), so codegen paths that must touch the filesystem still drive through
 * `run_generator`.
 */
export function shellGenerator(
	name: string,
	summary: string,
	command: string,
	opts: ShellOptions = {},
): RegisteredGenerator {
	const run: Generator = async (): Promise<GeneratorResult> => {
		const { code, output } = await runShell(command, opts)
		if (code !== 0)
			throw new Error(`generator "${name}" failed (exit ${code}):\n${output}`)
		return {
			generator: name,
			artifacts: [],
			notes: [output.trim() || `${name}: ok`],
		}
	}
	return { name, summary, run }
}
