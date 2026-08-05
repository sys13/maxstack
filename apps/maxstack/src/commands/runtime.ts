/**
 * `maxstack runtime link|unlink|status` — the sanctioned local-override path
 * for the web runtime.
 *
 * Before this, a contributor with a runtime fix in hand had no supported way to
 * see it run inside a real generated project. The folk procedure was: rebuild
 * `@maxstack/web`, `mv` the global install's `maxstack-runtime/build` aside,
 * `cp -a` the fresh build in, kill the dev server (the old bundle is held in
 * memory), restart, reconnect MCP. It works, it is undocumented, it patches one
 * machine, and it silently rots the moment the CLI updates.
 *
 * `runtime link` replaces all of that with a recorded path: `resolveRuntime`
 * reads it first, so `dev` runs the checkout's vite dev server (HMR, real
 * component names, no build step at all) and `build`/`deploy` vendor from the
 * checkout. `unlink` restores the installed runtime.
 *
 * The record lives in the project's data dir, which is gitignored — a link is
 * one contributor's debugging state on one machine, never a fact a teammate
 * inherits by pulling.
 */

import { relative } from 'node:path'
import { loadProject } from '../lib/project.ts'
import {
	isForgeRoot,
	readRuntimeLink,
	removeRuntimeLink,
	resolveRuntime,
	runtimeLinkPath,
	writeRuntimeLink,
} from '../lib/runtime.ts'

/** `maxstack runtime link <path> [dir]` — point this project at a checkout. */
export async function runtimeLinkCommand(
	dir: string,
	target: string,
): Promise<void> {
	const project = await loadProject(dir)
	const link = await writeRuntimeLink(project.root, target)
	console.log(
		`✔ linked runtime → ${link.path}\n` +
			`  recorded in ${relative(project.root, await runtimeLinkPath(project.root))} (gitignored — local to this machine)\n\n` +
			`  \`maxstack dev\` now runs that checkout's vite dev server: HMR, real\n` +
			`  component names in devtools, and edits under apps/web take effect live —\n` +
			`  no rebuild, no copying a build/ dir over an npm install.\n` +
			`  \`maxstack build\`/\`deploy\` vendor from it too, so an image built while\n` +
			`  linked contains unpublished runtime code.\n\n` +
			`  Undo with: maxstack runtime unlink`,
	)
	// A dev server already running still holds the *old* runtime in memory.
	console.log(
		'\n· restart any running `maxstack dev` — a live server keeps serving the\n' +
			'  runtime it started with.',
	)
}

/** `maxstack runtime unlink [dir]` — go back to the installed runtime. */
export async function runtimeUnlinkCommand(dir: string): Promise<void> {
	const project = await loadProject(dir)
	const existing = await readRuntimeLink(project.root)
	const removed = await removeRuntimeLink(project.root)
	if (!removed || !existing) {
		console.log(
			'· no runtime link recorded for this project — nothing to undo.',
		)
		return
	}
	console.log(
		`✔ unlinked (was ${existing.path}).\n` +
			'  Back to the resolved runtime; restart `maxstack dev` to pick it up.',
	)
}

/** `maxstack runtime status [dir]` — which runtime this project resolves to,
 * and why. The one place to answer "is the app I'm looking at the released
 * runtime or my checkout?" without reading source. */
export async function runtimeStatusCommand(dir: string): Promise<void> {
	const project = await loadProject(dir)
	console.log(await runtimeStatusReport(project.root))
}

/** The report body — separated from the command so tests can assert on it. */
export async function runtimeStatusReport(
	projectRoot: string,
): Promise<string> {
	const link = await readRuntimeLink(projectRoot)
	const lines: string[] = []
	if (link) {
		const valid = await isForgeRoot(link.path)
		lines.push(
			`link:    ${link.path} ${valid ? '(valid)' : '(BROKEN — not a maxstack checkout)'}`,
			`         linked ${link.linkedAt}`,
		)
	} else {
		lines.push('link:    none (using the resolved runtime)')
	}
	try {
		const runtime = await resolveRuntime(projectRoot)
		lines.push(
			runtime.mode === 'checkout'
				? `runtime: checkout at ${runtime.root}${runtime.linkedFrom ? ' (via link — unpublished code)' : ''}`
				: `runtime: maxstack-runtime ${runtime.version} at ${runtime.pkgDir}`,
		)
	} catch (err) {
		lines.push(`runtime: UNRESOLVED — ${(err as Error).message.split('\n')[0]}`)
	}
	return lines.join('\n')
}
