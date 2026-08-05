/**
 * `maxstack build [dir]` — vendor a **portable, self-contained** deployable
 * runtime for THIS project under `<project>/.maxstack/runtime/`, then (unless
 * `--vendor-only`) turn it into a Docker image.
 *
 * The runtime (`apps/web`) is a spec interpreter: it composes the navigable app
 * from the `spec/` directory at request time (see `project-routes.ts`). Spec-as-data alone
 * (Bar 1) deploys generic CRUD; a project's *owned* code — filled `*.slots.tsx`
 * and ejected route modules — is a seam the live server never imports. This verb
 * closes that seam AND relocates the whole build out of the maxstack checkout:
 *
 *   1. **Vendor** — clone the workspace *source* (all `packages/*`, `apps/*`,
 *      `examples`, plus the pnpm manifests + `tsconfig.base.json`, minus test
 *      files) into `<project>/.maxstack/runtime/`. Because the clone preserves the exact
 *      relative layout of the workspace root, every `tsconfig extends`, workspace
 *      glob, and `@maxstack/*` package `exports` path resolves identically — so
 *      the source-export package shape (a `react-router build` inlines the five
 *      workspace packages, W1) works unchanged with the runtime dir as its own
 *      workspace root. No npm publish, no lockfile regeneration.
 *   2. **Wire owned code** — mirror the project's `app/` into
 *      `apps/web/app/project/` and generate `apps/web/app/owned.generated.tsx`
 *      (static imports keyed by resource) so the build bundles + executes the
 *      owned modules (Bar 2, W4).
 *   3. **Bake the spec + emit deploy artifacts** — copy the project `spec/` dir
 *      to the runtime root and drop a `Dockerfile` / `.dockerignore` / `fly.toml`
 *      whose build *context is the runtime dir itself*. The project is now
 *      portable: `cd .maxstack/runtime && docker build .` needs no maxstack checkout.
 *
 * Previously (W2 "vendoring-lite") the build landed in `apps/web/build/` inside
 * the maxstack checkout; this verb completes strategy C by relocating the artifact
 * under the project. `maxstack deploy` builds on the same vendored tree.
 */

import { spawn } from 'node:child_process'
import { cp, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { basename, resolve } from 'node:path'
import {
	MANIFEST_FILENAME,
	parseManifest,
	type RouteManifest,
	renderOwnedManifest,
} from '@maxstack/core/ownership'
import { pathExists } from '../fsx.ts'
import { loadProject, type Project } from '../lib/project.ts'
import {
	linkedRuntimeBanner,
	type Runtime,
	resolveRuntime,
} from '../lib/runtime.ts'

// `renderOwnedManifest` — the owned-code manifest generator — now lives in
// `@maxstack/core` (`ownership/owned-codegen.ts`) so `maxstack dev`'s vite
// plugin can reuse the exact same function, not a forked copy.

/** Directory names never copied into the vendored tree — regenerated in the
 * image (`node_modules`, `build`) or irrelevant to it (`.git`, caches). */
const SKIP_DIRS = new Set([
	'node_modules',
	'build',
	'dist',
	'dist-npm', // npm release staging (scripts/stage-npm.ts) — also the clone's own output dir
	'.maxstack',
	'.turbo',
	'.react-router',
	'.git',
	'coverage',
])

/** Root files cloned verbatim so the vendored tree is a valid pnpm workspace
 * root with the same relative layout as the source (see file header). */
const ROOT_FILES = [
	'pnpm-lock.yaml',
	'pnpm-workspace.yaml',
	'package.json',
	'tsconfig.base.json',
	'turbo.json',
	'biome.json',
]

/** npm strips lockfiles (`pnpm-lock.yaml` is on its always-exclude list) from
 * published tarballs, so the `maxstack-runtime` package ships the snapshot's
 * lockfile under this name; `cloneWorkspace` restores the real name. */
export const LOCKFILE_SNAPSHOT = 'pnpm-lock.snapshot.yaml'

/** Written at the vendored tree's root by `vendorRuntime`, recording the runtime
 * version the tree was cloned from. `dev --owned` reuses `.maxstack/runtime/`
 * across runs, so this is how it detects a tree left behind by an older maxstack
 * (which can't read a newer spec format) and re-vendors instead of 404-ing. */
export const RUNTIME_STAMP_FILENAME = '.maxstack-runtime-version'

/** The runtime version the vendored tree under `runtimeDir` was cloned from, or
 * `null` if unstamped (never vendored, or vendored by a pre-stamp maxstack). */
export async function readRuntimeStamp(
	runtimeDir: string,
): Promise<string | null> {
	try {
		return (
			await readFile(resolve(runtimeDir, RUNTIME_STAMP_FILENAME), 'utf8')
		).trim()
	} catch {
		return null
	}
}

/** The runtime version to stamp a vendored tree with. `package` mode carries the
 * installed `maxstack-runtime` version; a checkout has no release version, so
 * `dev --owned` never reuses a checkout-vendored tree (it uses the vite hot loop
 * directly) — `'checkout'` just marks the origin. */
export function stampVersion(runtime: Runtime): string {
	return runtime.mode === 'package' ? runtime.version : 'checkout'
}

/** Resolve the source root to vendor from *and* the version to stamp it with.
 * Announces a linked runtime: an image vendored from a link ships
 * unpublished runtime code, which the person running `build`/`deploy` must know
 * before the artifact exists, not after it is deployed. */
export async function vendorSource(
	projectRoot: string,
): Promise<{ root: string; version: string }> {
	const runtime = await resolveRuntime(projectRoot)
	if (runtime.mode === 'checkout' && runtime.linkedFrom) {
		console.log(linkedRuntimeBanner(runtime.linkedFrom))
	}
	return { root: runtime.root, version: stampVersion(runtime) }
}

/** Workspace member dirs to clone (source only). These must be exactly the dirs
 * the vendored `pnpm-workspace.yaml` globs match: the lockfile is reused rather
 * than regenerated, and `pnpm install --frozen-lockfile` fails if the set of
 * importers on disk disagrees with it. Adding a workspace member without adding
 * it here produces a vendored tree that cannot install. */
export const MEMBER_DIRS = ['packages', 'apps', 'examples']

/** A conservative, deterministic image tag from the project name. */
export function imageTag(name: string): string {
	const slug = name
		.toLowerCase()
		.replace(/[^a-z0-9._-]+/g, '-')
		.replace(/^-+|-+$/g, '')
	return `maxstack-${slug || 'app'}`
}

/**
 * Test files, which the vendored tree never runs.
 *
 * `maxstack build` installs dependencies and runs the react-router build; no
 * step compiles a `.test.ts`. They are pure weight in the runtime tarball —
 * about a quarter of the source snapshot — and every megabyte here is paid on
 * a cold `npx maxstack` by every user, over the network.
 *
 * Excluding them cannot affect the build: nothing imports a test file, and
 * `pnpm install --frozen-lockfile` compares importers (directories with a
 * `package.json`), not file contents.
 */
const TEST_FILE = /\.(test|spec)\.[cm]?[jt]sx?$/

async function copyTree(src: string, dest: string): Promise<void> {
	await cp(src, dest, {
		recursive: true,
		filter: (from) =>
			!SKIP_DIRS.has(basename(from)) && !TEST_FILE.test(basename(from)),
	})
}

/**
 * Structurally clone a workspace root (checkout or runtime-package snapshot)
 * into `dest`: the root manifests + every member dir, sources only. Also used
 * by the runtime-package staging script to produce the snapshot itself.
 */
export async function cloneWorkspace(
	root: string,
	dest: string,
): Promise<void> {
	for (const f of ROOT_FILES) {
		// A snapshot ships the lockfile under a publish-safe name (see
		// LOCKFILE_SNAPSHOT); restore the real name in the clone.
		const from =
			f === 'pnpm-lock.yaml' &&
			!(await pathExists(resolve(root, f))) &&
			(await pathExists(resolve(root, LOCKFILE_SNAPSHOT)))
				? resolve(root, LOCKFILE_SNAPSHOT)
				: resolve(root, f)
		if (await pathExists(from)) await cp(from, resolve(dest, f))
	}
	for (const d of MEMBER_DIRS) {
		const from = resolve(root, d)
		if (await pathExists(from)) await copyTree(from, resolve(dest, d))
	}
}

export interface VendorResult {
	/** `<project>/.maxstack/runtime` — the portable build tree + Docker context. */
	runtimeDir: string
	/** How many owned modules (filled slots + ejected routes) were compiled in. */
	owned: number
}

/**
 * Produce the portable, self-contained runtime tree under the project. Idempotent:
 * the tree is removed and re-cloned each call, so it always reflects the current
 * source + owned code + spec.
 */
export async function vendorRuntime(
	project: Project,
	root: string,
	version = 'unknown',
): Promise<VendorResult> {
	const runtimeDir = resolve(project.root, '.maxstack', 'runtime')
	await rm(runtimeDir, { recursive: true, force: true })
	await mkdir(runtimeDir, { recursive: true })

	// 1. Clone the workspace source (a structural clone → all relative paths hold).
	await cloneWorkspace(root, runtimeDir)

	// Version-stamp the tree so `dev --owned` can tell a stale reuse (vendored by
	// an older maxstack, wrong spec format) from a current one and re-vendor.
	await writeFile(resolve(runtimeDir, RUNTIME_STAMP_FILENAME), `${version}\n`)

	// 2. Wire the project's owned code into the vendored apps/web.
	const webApp = resolve(runtimeDir, 'apps/web/app')
	const projectMirror = resolve(webApp, 'project')
	await rm(projectMirror, { recursive: true, force: true })
	await cp(project.appPath, projectMirror, { recursive: true })

	const manifestPath = resolve(project.appPath, MANIFEST_FILENAME)
	const manifest: RouteManifest = (await pathExists(manifestPath))
		? parseManifest(await readFile(manifestPath, 'utf8'))
		: { version: 1, entries: [] }
	await writeFile(
		resolve(webApp, 'owned.generated.tsx'),
		renderOwnedManifest(manifest),
	)
	const owned = manifest.entries.filter(
		(e) => e.slotFile || e.ownership === 'ejected',
	).length

	// 3. Bake the spec + emit deploy artifacts with context = the runtime dir.
	await cp(project.specDir, resolve(runtimeDir, 'spec'), { recursive: true })
	await cp(
		resolve(project.root, 'maxstack.json'),
		resolve(runtimeDir, 'maxstack.json'),
	)
	await cp(
		resolve(root, 'apps/web/Dockerfile'),
		resolve(runtimeDir, 'Dockerfile'),
	)
	await cp(resolve(root, '.dockerignore'), resolve(runtimeDir, '.dockerignore'))
	await writeFile(
		resolve(runtimeDir, 'fly.toml'),
		renderFlyToml(project.config.name),
	)

	return { runtimeDir, owned }
}

/** Fly.io config for the vendored tree: context = the tree, spec = `spec/`. */
export function renderFlyToml(name: string): string {
	const app = imageTag(name)
	return `# Fly.io deploy config for ${name} — generated by \`maxstack build\`.
# The build context is THIS directory (the vendored runtime); \`spec/\` (the
# project spec directory) is baked as the app's data dir. Run \`fly deploy\` from
# here, or \`maxstack deploy --target fly\`. Full runbook: maxstack/docs/deploy.md.
app = "${app}"
primary_region = "iad"

[build]
  dockerfile = "Dockerfile"
  [build.args]
    SPEC_DIR = "spec"

[env]
  PORT = "3000"
  # Set to "1" once real users + DATABASE_URL are in place (drops the dev-admin
  # fallback).
  # MAXSTACK_AUTH_STRICT = "1"

[http_service]
  internal_port = 3000
  force_https = true
  auto_stop_machines = "stop"
  auto_start_machines = true
  min_machines_running = 0

[[vm]]
  size = "shared-cpu-1x"
  memory = "512mb"

# Postgres (recommended — pglite state is lost when a machine recycles):
#   fly postgres create --name ${app}-db
#   fly postgres attach ${app}-db     # injects DATABASE_URL as a secret
`
}

/** Run \`docker build\` with the vendored tree as context. Streams to stdout. */
export function dockerBuild(runtimeDir: string, tag: string): Promise<void> {
	return new Promise((res, reject) => {
		const child = spawn(
			'docker',
			[
				'build',
				'-f',
				'Dockerfile',
				'--build-arg',
				'SPEC_DIR=spec',
				'-t',
				tag,
				'.',
			],
			{ cwd: runtimeDir, stdio: 'inherit', env: { ...process.env } },
		)
		child.on('error', reject)
		child.on('close', (code) =>
			code === 0 ? res() : reject(new Error(`docker build exited ${code}`)),
		)
	})
}

export interface BuildOptions {
	/** Docker image tag (default `maxstack-<name>`). */
	image?: string
	/** Produce the portable tree only; skip the Docker image build. */
	vendorOnly?: boolean
}

export async function buildCommand(
	dir: string | undefined,
	opts: BuildOptions = {},
): Promise<void> {
	const project = await loadProject(dir ?? '.')
	const { root, version } = await vendorSource(project.root)

	console.log(`vendoring runtime for ${project.config.name}…`)
	const { runtimeDir, owned } = await vendorRuntime(project, root, version)
	console.log(
		`✔ portable runtime at ${runtimeDir}` +
			`\n  ${owned} owned module(s) compiled in · spec baked · Dockerfile + fly.toml emitted`,
	)

	if (opts.vendorOnly) {
		console.log(
			`\nnext: build an image with\n  docker build -t <tag> ${runtimeDir}\nor \`maxstack deploy ${dir ?? '.'}\`.`,
		)
		return
	}

	const tag = opts.image ?? imageTag(project.config.name)
	console.log(`\nbuilding image ${tag} (docker build)…`)
	await dockerBuild(runtimeDir, tag)
	console.log(
		`✔ image ${tag} built.` +
			`\n  run:    docker run -p 3000:3000 ${tag}` +
			`\n  deploy: maxstack deploy ${dir ?? '.'}`,
	)
}
