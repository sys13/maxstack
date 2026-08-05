/**
 * Version control for a freshly scaffolded project.
 *
 * **Never-clobber is the safety story for owned code**, and it silently assumed
 * a precondition the scaffold did not create. The guarantee is "the platform
 * will not overwrite what you wrote" — but the recovery behind it, the thing
 * that makes a mistake survivable, is `git diff` and `git checkout --`. `init`
 * wrote a `.gitignore` for a repository that never existed, which is the tell:
 * the scaffold was already assuming version control while leaving it to the
 * user's habits.
 *
 * So `init` creates the repo and makes the first commit. That first commit is
 * the load-bearing part: a repo with no commits gives you nothing to diff
 * against, which is most of what you wanted the repo for.
 *
 * Three outcomes, all reported, none of them silent:
 *   - `initialized` — a new repo with a scaffold commit;
 *   - `already` — the directory is already inside a work tree, so the
 *     precondition holds and creating a nested repo would be actively wrong;
 *   - `unavailable` — git is missing or refused. The scaffold still succeeds,
 *     and the caller says out loud that never-clobber has no undo behind it,
 *     because a guarantee whose recovery path is missing should not be
 *     discovered at the moment it is needed.
 */

import { commandExists, run } from './exec.ts'

export type GitBootstrapStatus = 'initialized' | 'already' | 'unavailable'

export interface GitBootstrap {
	status: GitBootstrapStatus
	/** Why, for the two non-initializing outcomes. */
	reason?: string
}

/** Is this directory already inside a git work tree? */
async function insideWorkTree(dir: string): Promise<boolean> {
	try {
		await run('git', ['rev-parse', '--is-inside-work-tree'], {
			cwd: dir,
			inherit: false,
		})
		return true
	} catch {
		return false
	}
}

/**
 * Put `dir` under version control, with a first commit to diff against.
 *
 * Best-effort by design: a scaffold that fails outright because `git` is absent
 * is worse than one that succeeds and says what is missing. The caller is
 * responsible for saying it — see {@link GitBootstrap}.
 */
export async function bootstrapRepo(dir: string): Promise<GitBootstrap> {
	if (!commandExists('git'))
		return {
			status: 'unavailable',
			reason: 'git is not on PATH',
		}
	// A nested repo inside an existing checkout is a trap, not a service: the
	// outer repo stops seeing these files and nobody notices until a push.
	if (await insideWorkTree(dir))
		return {
			status: 'already',
			reason: 'this directory is already inside a git work tree',
		}
	try {
		await run('git', ['init', '-q'], { cwd: dir, inherit: false })
		await run('git', ['add', '-A'], { cwd: dir, inherit: false })
		// -c so this never depends on, or writes to, the user's global config.
		await run(
			'git',
			[
				'-c',
				'user.name=maxstack',
				'-c',
				'user.email=scaffold@maxstack.local',
				'commit',
				'-q',
				'-m',
				'Initial scaffold from maxstack',
			],
			{ cwd: dir, inherit: false },
		)
		return { status: 'initialized' }
	} catch (e) {
		return {
			status: 'unavailable',
			reason: e instanceof Error ? e.message : String(e),
		}
	}
}

/** What to tell the user, given the outcome. `null` when nothing needs saying. */
export function gitBootstrapNotice(result: GitBootstrap): string | null {
	if (result.status === 'initialized') return null
	if (result.status === 'already') return null
	return (
		`no version control here (${result.reason}). maxstack never overwrites code you own, ` +
		'but that promise assumes you can diff and revert — run `git init && git add -A && git commit` ' +
		'before you start writing, or the first mistake has no undo.'
	)
}
