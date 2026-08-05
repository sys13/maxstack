/**
 * Thin wrappers over child_process for running external tools (git, gh, vp,
 * claude). Kept in one place so command modules stay readable.
 */
import { spawn, spawnSync } from 'node:child_process'

export interface RunOptions {
	cwd?: string
	/** Inherit stdio so the user sees live output. Default true. */
	inherit?: boolean
}

/** Run a command, streaming output. Resolves on exit; rejects on non-zero. */
export function run(
	cmd: string,
	args: string[],
	opts: RunOptions = {},
): Promise<void> {
	return new Promise((resolvePromise, reject) => {
		const child = spawn(cmd, args, {
			cwd: opts.cwd,
			stdio: opts.inherit === false ? 'pipe' : 'inherit',
		})
		child.on('error', reject)
		child.on('close', (code) => {
			if (code === 0) resolvePromise()
			else reject(new Error(`${cmd} ${args.join(' ')} exited with code ${code}`))
		})
	})
}

/** Return true if a command exists on PATH. */
export function commandExists(cmd: string): boolean {
	const probe = process.platform === 'win32' ? 'where' : 'which'
	return spawnSync(probe, [cmd], { stdio: 'ignore' }).status === 0
}

/** Run and capture stdout (trimmed). Throws on non-zero exit. */
export function capture(cmd: string, args: string[], cwd?: string): string {
	const result = spawnSync(cmd, args, { cwd, encoding: 'utf8' })
	if (result.status !== 0) {
		throw new Error(
			`${cmd} ${args.join(' ')} failed: ${result.stderr?.trim() || result.status}`,
		)
	}
	return result.stdout.trim()
}
