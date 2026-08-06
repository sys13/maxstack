/**
 * Generate `CHANGELOG.md` for the two lockstep npm packages from the commit
 * graph. Releases are `chore(release): maxstack@X.Y.Z` commits (no tags); each
 * version's section is the conventional-commit summary of the commits between
 * its release commit and the previous one. Used by `stage-npm.ts`, and unit-
 * tested against a scratch git repo — hence a standalone, side-effect-free
 * module rather than inline in the staging script.
 */

import { spawn } from 'node:child_process'
import { readFile } from 'node:fs/promises'
import { resolve } from 'node:path'

/** Sections this repository's commit graph cannot produce, appended verbatim.
 * The public repo starts at a fresh root commit, so every release before it
 * exists only here — regenerating without this would silently delete them. */
const ARCHIVE = 'CHANGELOG.archive.md'

async function readArchive(cwd: string): Promise<string> {
	try {
		return (await readFile(resolve(cwd, ARCHIVE), 'utf8')).trim()
	} catch {
		return ''
	}
}

/** Run a command and capture its stdout (trimmed); '' on any failure. */
export function capture(
	cmd: string,
	args: string[],
	cwd: string,
): Promise<string> {
	return new Promise((res) => {
		const child = spawn(cmd, args, { cwd })
		let buf = ''
		child.stdout.on('data', (d) => {
			buf += d
		})
		child.on('close', () => res(buf.trim()))
		child.on('error', () => res(''))
	})
}

/** Conventional-commit type → changelog section. Types absent here (chore, docs,
 * test, style, ci, build) are internal noise: counted, not listed. */
const SECTIONS: [type: string, heading: string][] = [
	['feat', 'Features'],
	['fix', 'Fixes'],
	['perf', 'Performance'],
	['revert', 'Reverts'],
	['other', 'Other changes'],
]
const HIDDEN = new Set(['chore', 'docs', 'test', 'style', 'ci', 'build'])
/** Every type that lands somewhere. A subject like `maxstack: a framework…`
 * parses as conventional with type `maxstack`, which is in neither set — it used
 * to match no section and no hidden count, and vanish. Unknown types are treated
 * as prose instead (see `classify`). */
const KNOWN = new Set([...SECTIONS.map(([type]) => type), ...HIDDEN])

export interface Change {
	type: string
	scope: string | null
	breaking: boolean
	desc: string
	hash: string
}

/** Parse a commit subject into a changelog entry. Non-conventional subjects are
 * bucketed by leading verb (so nothing a release shipped is silently dropped). */
export function classify(subject: string, hash: string): Change {
	const m = subject.match(/^(\w+)(?:\(([^)]+)\))?(!)?:\s*(.+)$/)
	if (m && KNOWN.has(m[1].toLowerCase())) {
		const [, type, scope, bang, desc] = m
		return {
			type: type.toLowerCase(),
			scope: scope ?? null,
			breaking: Boolean(bang),
			desc,
			hash,
		}
	}
	const verb = subject.match(/^(fix|add|feat|revert)\b/i)?.[1]?.toLowerCase()
	const type = verb === 'add' ? 'feat' : (verb ?? 'other')
	return { type, scope: null, breaking: false, desc: subject, hash }
}

/** `git+https://github.com/x/y.git` → `https://github.com/x/y` (or ''). */
export function webRepo(repository: unknown): string {
	const url =
		typeof repository === 'string'
			? repository
			: (repository as { url?: string })?.url
	return (url ?? '')
		.replace(/^git\+/, '')
		.replace(/\.git$/, '')
		.replace(/^git:/, 'https:')
}

/** Render one version's section from its commit list. Returns '' when the range
 * has nothing worth noting (all release/merge noise). */
function renderSection(
	version: string,
	date: string,
	changes: Change[],
	link: (h: string) => string,
): string {
	const heading = `## ${version}${date ? ` — ${date}` : ''}`
	const breaking = changes.filter((c) => c.breaking)
	const hidden = changes.filter((c) => HIDDEN.has(c.type) && !c.breaking).length
	const bullet = (c: Change) =>
		`- ${c.scope ? `**${c.scope}:** ` : ''}${c.desc}${link(c.hash)}`

	const lines: string[] = []
	if (breaking.length)
		lines.push('### ⚠ Breaking changes', ...breaking.map(bullet), '')
	for (const [type, label] of SECTIONS) {
		const items = changes.filter(
			(c) => c.type === type && !c.breaking && !HIDDEN.has(c.type),
		)
		if (items.length) lines.push(`### ${label}`, ...items.map(bullet), '')
	}
	if (lines.length === 0 && hidden === 0) return ''
	if (hidden > 0)
		lines.push(`_${hidden} internal change${hidden === 1 ? '' : 's'}._`, '')
	return `${heading}\n\n${lines.join('\n').trimEnd()}`
}

/** Render the whole CHANGELOG.md from the commit graph: one section per released
 * version (pairwise between `chore(release):` commits), newest first, plus a
 * top section for `stagedVersion` when its release commit isn't in history yet. */
export async function buildChangelog(
	stagedVersion: string,
	repository: unknown,
	cwd: string,
): Promise<string> {
	const web = webRepo(repository)
	const link = (h: string) =>
		web ? ` ([\`${h}\`](${web}/commit/${h}))` : ` (\`${h}\`)`

	const raw = await capture(
		'git',
		[
			'log',
			'--format=%H%x1f%s%x1f%ad',
			'--date=short',
			'--fixed-strings',
			'--grep=chore(release): maxstack@',
		],
		cwd,
	)
	const releases = raw
		.split('\n')
		.filter(Boolean)
		.map((line) => {
			const [hash, subject, date] = line.split('\x1f')
			const version = subject.match(/maxstack@(\d+\.\d+\.\d+\S*)/)?.[1]
			return version ? { hash, version, date } : null
		})
		.filter(
			(r): r is { hash: string; version: string; date: string } => r !== null,
		)

	// Boundaries per section, newest first: [from..to] with from='' meaning
	// "no predecessor" (the initial release).
	const bounds: { version: string; date: string; from: string; to: string }[] =
		[]
	const headDate = await capture(
		'git',
		['log', '-1', '--format=%ad', '--date=short', 'HEAD'],
		cwd,
	)
	if (releases.length === 0 || releases[0].version !== stagedVersion) {
		// The release commit for stagedVersion isn't in history yet — top section
		// covers everything since the last committed release.
		bounds.push({
			version: stagedVersion,
			date: headDate,
			from: releases[0]?.hash ?? '',
			to: 'HEAD',
		})
	}
	for (let i = 0; i < releases.length; i++) {
		bounds.push({
			version: releases[i].version,
			date: releases[i].date,
			from: releases[i + 1]?.hash ?? '',
			to: releases[i].hash,
		})
	}

	const archive = await readArchive(cwd)

	const sections: string[] = []
	for (const b of bounds) {
		if (!b.from && !archive) {
			// Oldest release with nothing behind it: don't dump pre-history, mark it.
			sections.push(
				`## ${b.version}${b.date ? ` — ${b.date}` : ''}\n\n- Initial release.`,
			)
			continue
		}
		// No predecessor, but the archive covers everything older — so this
		// section is the whole graph, which is exactly this repository's history.
		const range = b.from ? `${b.from}..${b.to}` : b.to
		const log = await capture(
			'git',
			['log', range, '--no-merges', '--format=%s%x1f%h'],
			cwd,
		)
		const changes = log
			.split('\n')
			.filter(Boolean)
			.map((l) => {
				const [subject, hash] = l.split('\x1f')
				return { subject, hash }
			})
			.filter(({ subject }) => !subject.startsWith('chore(release)'))
			.map(({ subject, hash }) => classify(subject, hash))

		const section = renderSection(b.version, b.date, changes, link)
		if (section) sections.push(section)
	}

	return `# Changelog

All notable changes to \`maxstack\` and \`maxstack-runtime\` (they ship in
lockstep). Generated from the commit history at release time by
\`scripts/stage-npm.ts\`.

${[...sections, archive].filter(Boolean).join('\n\n')}\n`
}
