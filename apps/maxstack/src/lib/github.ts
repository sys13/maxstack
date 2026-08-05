/**
 * Creates a private GitHub repo for a freshly scaffolded project and pushes the
 * initial commit, using the `gh` CLI. Best-effort: if `gh` is missing or the
 * user isn't authenticated, we skip cleanly rather than failing the whole
 * scaffold — the local repo is already committed and usable.
 */
import { capture, commandExists, run } from './exec.ts'

export interface GitHubResult {
	created: boolean
	url?: string
	reason?: string
}

/**
 * Derive the `owner/name` slug from a gitRemote like "github.com/my-org"
 * plus the project name. Returns null when the config still carries the
 * shipped placeholder org, so the caller falls back to the authenticated
 * account instead of trying to create a repo under "your-org".
 */
export function repoSlug(gitRemote: string, name: string): string | null {
	const org = gitRemote
		.replace(/^https?:\/\//, '')
		.replace(/^github\.com\//, '')
	if (!org || org === 'your-org') return null
	return `${org}/${name}`
}

export async function createAndPush(
	projectDir: string,
	gitRemote: string,
	name: string,
): Promise<GitHubResult> {
	if (!commandExists('gh')) {
		return {
			created: false,
			reason: 'gh CLI not found; skipped GitHub repo creation',
		}
	}

	let slug = repoSlug(gitRemote, name)

	try {
		if (!slug) {
			slug = `${capture('gh', ['api', 'user', '--jq', '.login'])}/${name}`
		}
		// `gh repo create <slug> --private --source . --push` creates the remote,
		// wires up `origin`, and pushes the current branch in one step.
		await run(
			'gh',
			[
				'repo',
				'create',
				slug,
				'--private',
				'--source',
				'.',
				'--remote',
				'origin',
				'--push',
			],
			{ cwd: projectDir },
		)
		return { created: true, url: `https://github.com/${slug}` }
	} catch (err) {
		return {
			created: false,
			reason: err instanceof Error ? err.message : 'gh repo create failed',
		}
	}
}
