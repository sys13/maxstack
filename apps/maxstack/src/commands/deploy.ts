/**
 * `maxstack deploy [dir]` — deploy the vendored runtime for a project (task 30,
 * the deploy verb; strategy C).
 *
 * Builds on `maxstack build`'s portable tree (`<project>/.maxstack/runtime/`):
 * it (re-)vendors, then ships the image to a target.
 *
 *   --target docker (default)  build the image and run it locally as a detached
 *                              container (`-p <port>:3000`), print the URL. This
 *                              is the fully local, verifiable path.
 *   --target fly               ensure the vendored tree + `fly.toml`, then print
 *                              the `fly` runbook. Deploying to Fly is an outward,
 *                              account-scoped action, so it is NOT run unless
 *                              `--execute` is passed (then `fly deploy` runs from
 *                              the runtime dir).
 *
 * Postgres in prod: pass `DATABASE_URL` (docker `-e`, or `fly secrets set`); the
 * runtime selects postgres.js over pglite automatically (task 22). Without it the
 * app runs on pglite over the baked spec dir (ephemeral on container recycle).
 */

import { spawn } from 'node:child_process'
import type { InstalledBundle } from '@maxstack/features/bundle'
import { loadProject } from '../lib/project.ts'
import { dockerBuild, imageTag, vendorRuntime, vendorSource } from './build.ts'

export interface DeployOptions {
	/** `docker` (local run, default) or `fly`. */
	target?: string
	/** Host port for the local docker run (default `3000`). */
	port?: string
	/** Docker image tag (default `maxstack-<name>`). */
	image?: string
	/** For `--target fly`: actually run `fly deploy` (else print the runbook). */
	execute?: boolean
}

/** Spawn a command; resolve on exit 0, reject otherwise. `quiet` silences output
 * (used for the best-effort pre-clean of a stale container). */
function run(
	cmd: string,
	args: string[],
	cwd: string,
	quiet = false,
): Promise<void> {
	return new Promise((res, reject) => {
		const child = spawn(cmd, args, {
			cwd,
			stdio: quiet ? 'ignore' : 'inherit',
			env: { ...process.env },
		})
		child.on('error', reject)
		child.on('close', (code) =>
			code === 0 ? res() : reject(new Error(`${cmd} exited ${code}`)),
		)
	})
}

/**
 * The deploy-time security posture note. Deploying is the moment an
 * open REST API stops being a local convenience: `authorize()` is open-by-
 * default, so without the auth bundle no spec entity carries a rule and every
 * write is anonymous-writable. With auth installed, writes require a session —
 * but only `MAXSTACK_AUTH_STRICT=1` switches off the dev fallback that treats
 * anonymous callers as the local admin, so remind about that too.
 */
export function authPostureWarning(bundles: InstalledBundle[]): string {
	if (!bundles.some((b) => b.slug === 'auth')) {
		return (
			'⚠ SECURITY: no auth bundle installed — this deploy ships an OPEN REST API:' +
			'\n  anonymous requests can create/update/delete every spec entity.' +
			'\n  Run `maxstack add auth` first (writes then require a session), and set' +
			'\n  MAXSTACK_AUTH_STRICT=1 in the deploy target.'
		)
	}
	return (
		'ℹ auth bundle installed: spec-entity writes require a session. Set' +
		'\n  MAXSTACK_AUTH_STRICT=1 in the deploy target (docker: -e MAXSTACK_AUTH_STRICT=1,' +
		'\n  fly: fly secrets set MAXSTACK_AUTH_STRICT=1) — without it, anonymous callers' +
		'\n  fall back to the local dev admin and the session gate never bites.'
	)
}

export async function deployCommand(
	dir: string | undefined,
	opts: DeployOptions = {},
): Promise<void> {
	const target = opts.target ?? 'docker'
	if (target !== 'docker' && target !== 'fly') {
		throw new Error(`unknown --target ${target} (expected "docker" or "fly")`)
	}

	const project = await loadProject(dir ?? '.')
	const { root, version } = await vendorSource(project.root)
	console.warn(`\n${authPostureWarning(project.config.bundles)}\n`)

	console.log(`vendoring runtime for ${project.config.name}…`)
	const { runtimeDir, owned } = await vendorRuntime(project, root, version)
	console.log(`✔ portable runtime at ${runtimeDir} (${owned} owned module(s))`)

	if (target === 'fly') {
		const app = imageTag(project.config.name)
		if (!opts.execute) {
			console.log(
				`\nFly deploy is an outward, account-scoped action — not run without --execute.` +
					`\nTo ship it yourself, from ${runtimeDir}:\n` +
					`\n  fly launch --copy-config --no-deploy   # first time: create the app "${app}"` +
					`\n  fly deploy                             # build Dockerfile + ship` +
					`\n\n  # Postgres (recommended):` +
					`\n  fly postgres create --name ${app}-db && fly postgres attach ${app}-db` +
					`\n  fly secrets set MAXSTACK_AUTH_STRICT=1 && fly deploy` +
					`\n\nOr re-run with --execute to run \`fly deploy\` now.`,
			)
			return
		}
		console.log(`\nrunning \`fly deploy\` from ${runtimeDir}…`)
		await run('fly', ['deploy'], runtimeDir)
		console.log('✔ fly deploy complete.')
		return
	}

	// docker: build the image and run it locally as a detached container.
	const tag = opts.image ?? imageTag(project.config.name)
	const port = opts.port ?? '3000'
	console.log(`\nbuilding image ${tag}…`)
	await dockerBuild(runtimeDir, tag)

	// Replace any prior container of the same name so re-deploys are clean.
	await run('docker', ['rm', '-f', tag], runtimeDir, true).catch(() => {})
	console.log(`\nstarting container ${tag} on port ${port}…`)
	await run(
		'docker',
		['run', '-d', '--name', tag, '-p', `${port}:3000`, tag],
		runtimeDir,
	)
	console.log(
		`✔ ${project.config.name} deployed locally.` +
			`\n  open:  http://localhost:${port}` +
			`\n  logs:  docker logs -f ${tag}` +
			`\n  stop:  docker rm -f ${tag}` +
			`\n  (Postgres: docker run … -e DATABASE_URL=postgres://… ${tag})`,
	)
}
