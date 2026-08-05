/**
 * Locate the web runtime the platform verbs run against (`dev`/`demo`/`build`/
 * `deploy`). The CLI is installed two ways, and each ships the runtime
 * differently:
 *
 *   - **checkout** — running from the forge monorepo (source or a bundle built
 *     inside it). The runtime is `<root>/apps/web` with the full workspace
 *     around it: `dev` gets vite + HMR + the owned-slot hot loop, `build`
 *     vendors from the checkout.
 *   - **package** — installed from npm. The `maxstack-runtime` package (a
 *     dependency of the published CLI) ships a prebuilt react-router server
 *     (`build/`), a bundled seed entry (`seed-demo.mjs`), and a `workspace/`
 *     source snapshot with the same relative layout as the forge checkout, so
 *     `vendorRuntime` can clone from it exactly as it clones from a checkout.
 *
 * Resolution order: an explicit **link** first (`maxstack runtime link <path>`,
 * see below), then a *validated* walk-up (the dir must actually contain
 * `apps/web` named `@maxstack/web` — a bare `pnpm-workspace.yaml` check false-
 * positives on the CONSUMER's own workspace when the CLI runs from their
 * `node_modules`), then `maxstack-runtime` from the project's `node_modules`
 * (a project may pin its own runtime), then from the CLI's own dependencies.
 *
 * ## The link
 *
 * Three shipped bugs in a row lived in the prebuilt runtime, and the only way
 * to test a fix against a real project was a folk procedure: rebuild
 * `@maxstack/web`, `mv` the global install's `build/` aside, `cp -a` the fresh
 * one in, restart everything. Undocumented, fragile, one machine at a time.
 *
 * `maxstack runtime link <path-to-checkout>` records that path in the project's
 * (gitignored) data dir, and every runtime consumer resolves through it — so
 * `dev` runs the checkout's vite server (HMR, real component names) and `build`
 * vendors from the checkout. It is deliberately per-project and local-only: a
 * link is a contributor's debugging state, never something a teammate inherits
 * from a commit. Consumers announce it loudly (`linkedFrom`), because a linked
 * runtime is unpublished code.
 */

import { access, readFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

export const RUNTIME_PACKAGE = 'maxstack-runtime'

export type Runtime =
	| {
			mode: 'checkout'
			/** The forge workspace root (has `apps/web`, `packages/*`, manifests). */
			root: string
			/** Set when this checkout came from an explicit `runtime link` — the
			 * code being served is unpublished, and every consumer says so. */
			linkedFrom?: string
	  }
	| {
			mode: 'package'
			/** The installed `maxstack-runtime` package dir. */
			pkgDir: string
			/** `<pkgDir>/workspace` — the source snapshot `vendorRuntime` clones from. */
			root: string
			/** `<pkgDir>/build/server/index.js` — the prebuilt react-router server. */
			serverIndex: string
			/** `<pkgDir>/seed-demo.mjs` — the bundled demo-data seed entry. */
			seedScript: string
			/** The runtime package's version (for skew warnings). */
			version: string
	  }

/** True when `dir` is a real forge workspace root, not just any pnpm workspace. */
export async function isForgeRoot(dir: string): Promise<boolean> {
	try {
		await access(resolve(dir, 'pnpm-workspace.yaml'))
		const pkg = JSON.parse(
			await readFile(resolve(dir, 'apps/web/package.json'), 'utf8'),
		) as { name?: string }
		return pkg.name === '@maxstack/web'
	} catch {
		return false
	}
}

/** Walk up from the running CLI file looking for a validated forge root. */
async function findCheckoutRoot(): Promise<string | null> {
	let dir = dirname(fileURLToPath(import.meta.url))
	for (let i = 0; i < 12; i++) {
		if (await isForgeRoot(dir)) return dir
		const parent = dirname(dir)
		if (parent === dir) break
		dir = parent
	}
	return null
}

/** Resolve the installed `maxstack-runtime` package dir, or null. Tries the
 * project first (a project may pin its own runtime), then the CLI's own deps. */
function findRuntimePackage(projectRoot: string): string | null {
	const bases = [resolve(projectRoot, 'noop.js'), import.meta.url]
	for (const base of bases) {
		try {
			return dirname(
				createRequire(base).resolve(`${RUNTIME_PACKAGE}/package.json`),
			)
		} catch {
			// keep trying
		}
	}
	return null
}

/** The link record's filename inside the project's data dir. */
export const RUNTIME_LINK_FILENAME = 'runtime-link.json'

/** A recorded local-override link (`maxstack runtime link`). */
export interface RuntimeLink {
	/** Absolute path to the linked maxstack checkout. */
	path: string
	/** When the link was made (ISO), so `runtime status` can say how old it is. */
	linkedAt: string
}

/** The project's data dir (`maxstack.json`'s `dataDir`, default `.maxstack`).
 * Read directly rather than through `loadProject` — resolving a runtime must not
 * depend on opening the spec store. */
async function dataDirOf(projectRoot: string): Promise<string> {
	try {
		const config = JSON.parse(
			await readFile(resolve(projectRoot, 'maxstack.json'), 'utf8'),
		) as { dataDir?: unknown }
		if (typeof config.dataDir === 'string' && config.dataDir)
			return resolve(projectRoot, config.dataDir)
	} catch {
		// Not a project (or an unreadable config) — the default is still right.
	}
	return resolve(projectRoot, '.maxstack')
}

/** Where a project records its runtime link. */
export async function runtimeLinkPath(projectRoot: string): Promise<string> {
	return resolve(await dataDirOf(projectRoot), RUNTIME_LINK_FILENAME)
}

/** The recorded link, or `null` when there is none (or it is unreadable). */
export async function readRuntimeLink(
	projectRoot: string,
): Promise<RuntimeLink | null> {
	try {
		const parsed = JSON.parse(
			await readFile(await runtimeLinkPath(projectRoot), 'utf8'),
		) as { path?: unknown; linkedAt?: unknown }
		if (typeof parsed.path !== 'string' || !parsed.path) return null
		return {
			path: parsed.path,
			linkedAt:
				typeof parsed.linkedAt === 'string' ? parsed.linkedAt : 'unknown',
		}
	} catch {
		return null
	}
}

/** Record a link to a maxstack checkout. Validates the target is really one —
 * a typo'd path must fail here, not as a confusing runtime resolution later. */
export async function writeRuntimeLink(
	projectRoot: string,
	target: string,
	now: () => string = () => new Date().toISOString(),
): Promise<RuntimeLink> {
	const path = resolve(target)
	if (!(await isForgeRoot(path))) {
		throw new Error(
			`not a maxstack checkout: ${path}\n` +
				`  Expected a workspace root holding pnpm-workspace.yaml and apps/web\n` +
				`  (package "@maxstack/web") — i.e. the maxstack/ dir of a clone of\n` +
				`  https://github.com/sys13/maxstack.`,
		)
	}
	const link: RuntimeLink = { path, linkedAt: now() }
	const { mkdir, writeFile } = await import('node:fs/promises')
	const linkPath = await runtimeLinkPath(projectRoot)
	await mkdir(dirname(linkPath), { recursive: true })
	await writeFile(linkPath, `${JSON.stringify(link, null, '\t')}\n`)
	return link
}

/** Drop the link. Returns whether there was one to drop. */
export async function removeRuntimeLink(projectRoot: string): Promise<boolean> {
	const { rm } = await import('node:fs/promises')
	try {
		await rm(await runtimeLinkPath(projectRoot))
		return true
	} catch {
		return false
	}
}

/** The one-paragraph banner every consumer of a linked runtime prints. Loud on
 * purpose: nothing about the served app otherwise says "this is not the
 * released runtime", and that ambiguity is exactly what issue #143 is about. */
export function linkedRuntimeBanner(path: string): string {
	return (
		`· ⚠ LINKED RUNTIME — serving unpublished runtime code from\n` +
		`    ${path}\n` +
		`  Behavior here may not match the released maxstack-runtime. Run\n` +
		`  \`maxstack runtime unlink\` to go back to the installed one.`
	)
}

/**
 * Resolve the runtime for a project. Throws with an actionable message when
 * neither a forge checkout nor an installed `maxstack-runtime` is on hand.
 */
export async function resolveRuntime(projectRoot: string): Promise<Runtime> {
	// An explicit link wins over everything — it is the user saying "run *this*
	// tree", and silently ignoring it would recreate the un-diagnosable-runtime
	// problem it exists to solve.
	const link = await readRuntimeLink(projectRoot)
	if (link) {
		if (!(await isForgeRoot(link.path))) {
			throw new Error(
				`the linked runtime at ${link.path} is no longer a maxstack checkout ` +
					`(moved or deleted?).\n` +
					`  Re-link it (\`maxstack runtime link <path>\`) or drop the link ` +
					`(\`maxstack runtime unlink\`).`,
			)
		}
		return { mode: 'checkout', root: link.path, linkedFrom: link.path }
	}

	const checkout = await findCheckoutRoot()
	if (checkout) return { mode: 'checkout', root: checkout }

	const pkgDir = findRuntimePackage(projectRoot)
	if (pkgDir) {
		const pkg = JSON.parse(
			await readFile(resolve(pkgDir, 'package.json'), 'utf8'),
		) as { version?: string }
		return {
			mode: 'package',
			pkgDir,
			root: resolve(pkgDir, 'workspace'),
			serverIndex: resolve(pkgDir, 'build/server/index.js'),
			seedScript: resolve(pkgDir, 'seed-demo.mjs'),
			version: pkg.version ?? '0.0.0',
		}
	}

	throw new Error(
		`could not locate the maxstack web runtime.\n` +
			`  Install it into this project:  pnpm add -D ${RUNTIME_PACKAGE}\n` +
			`  (or run from a forge checkout for the full dev loop)`,
	)
}
