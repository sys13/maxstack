/**
 * Project layout + config for the platform verbs (`init`/`gen`/`op`/`eject`/
 * `validate`/`upgrade`). A maxstack project on disk is:
 *
 *   <root>/
 *     maxstack.json     — the project config (name, appDir, dataDir, backend)
 *     spec/             — the one-system spec, split by layer (product/data/
 *                         pages/pricing/ledger + oplog.jsonl); a legacy single
 *                         `spec.json` is migrated into this dir on first load
 *     app/              — generated route modules + slot stubs + route manifest
 *     .maxstack/        — durable runtime state (pglite db, telemetry) at dev time
 *
 * These helpers resolve that layout and open the disk-backed spec store, so the
 * commands stay small and never hard-code paths.
 */

import { resolve } from 'node:path'
import type { InstalledBundle } from '@maxstack/features/bundle'
import { createFileSpecStore, type SpecStore } from '@maxstack/mcp'
import { minimalPRD, newSpecSystem, type SpecSystem } from '@maxstack/spec'

/** On-disk project config (`maxstack.json`). */
export interface ProjectConfig {
	name: string
	/** Where generated route modules land (relative to the project root). */
	appDir: string
	/** Durable runtime state dir (`MAXSTACK_DATA_DIR`), relative to the root. */
	dataDir: string
	/** Store backend for `pnpm dev`: `pglite` (default) or `postgres`. */
	backend: 'pglite' | 'postgres'
	/**
	 * How human write verbs (`op`, `add-entity`, `add-field`) settle a change
	 *. `review` (default) lands the change and leaves it for the
	 * workbench queue; `auto` is the trusted-solo autopilot — every landed op is
	 * auto-accepted and the app tree regenerated in one shot, as if `--accept
	 * --gen` were always passed. Explicit `--accept`/`--gen` flags still win.
	 */
	reviewMode: 'review' | 'auto'
	/**
	 * Whether the runtime shows the cookie-consent banner.
	 * `auto` (default) shows it only when the `auth` bundle is installed — a
	 * personal app with no sign-in has nothing to disclose and shouldn't nag.
	 * `always` forces it (analytics/embeds the runtime can't see); `never`
	 * suppresses it outright. Optional: absent means `auto`.
	 */
	cookieBanner?: 'auto' | 'always' | 'never'
	/**
	 * Whether the workbench derives and shows **review-cost metrics** — how long
	 * approving a change actually takes. `off` (the default, and the
	 * value absent means) computes and shows nothing.
	 *
	 * Opt-in rather than opt-out, and that asymmetry is the point. This is
	 * maintainer telemetry about the maintainer's own reviewing; measuring our own
	 * dogfooding is legitimate, and switching it on in somebody else's project
	 * because we shipped the runtime they installed is not — least of all for a
	 * product selling review-first trust.
	 *
	 * `local` is the only enabled value and the name is the promise: derived from
	 * `telemetry.jsonl` in this project's own gitignored data dir, and there is no
	 * transport anywhere in the implementation. A hosted mode, if it ever exists,
	 * gets a different value and its own consent conversation, so `local` can
	 * never come to mean "uploaded".
	 *
	 * Overridable per session with `MAXSTACK_REVIEW_METRICS=local|off`.
	 * See docs/review-cost.md.
	 */
	reviewMetrics?: 'off' | 'local'
	/** Feature bundles installed into this project (`maxstack add`). */
	bundles: InstalledBundle[]
}

export const CONFIG_FILENAME = 'maxstack.json'
/** The spec directory (v2 split/compacted format), relative to the root. */
export const SPEC_DIRNAME = 'spec'
/** The legacy single-file spec, migrated into {@link SPEC_DIRNAME} on first load. */
export const SPEC_FILENAME = 'spec.json'

export const DEFAULT_CONFIG: Omit<ProjectConfig, 'name'> = {
	appDir: 'app',
	dataDir: '.maxstack',
	backend: 'pglite',
	// `auto` — a change you made yourself lands and regenerates in one step.
	//
	// The queue is for changes you did *not* make: an agent proposing through
	// MCP still arrives `suggested` and waits, because that is where the review
	// gate earns its keep. Defaulting a solo maintainer's own edits into a queue
	// only they can clear taught a ceremony with nothing behind it — the
	// terminal sugar already stamps its rows accepted, so `review` mostly meant
	// "type two more flags to get the behaviour you wanted".
	//
	// Set `"reviewMode": "review"` in maxstack.json to queue everything.
	reviewMode: 'auto',
	bundles: [],
}

export interface Project {
	root: string
	config: ProjectConfig
	/** The spec directory (`<root>/spec`) the disk store reads and writes. */
	specDir: string
	appPath: string
	spec: SpecStore
}

/** Read a project's config, throwing a clear error when the dir isn't one. */
export async function loadProject(root: string): Promise<Project> {
	const abs = resolve(root)
	const configPath = resolve(abs, CONFIG_FILENAME)
	const { readFile } = await import('node:fs/promises')
	let config: ProjectConfig
	try {
		config = { ...DEFAULT_CONFIG, ...JSON.parse(await readFile(configPath, 'utf8')) }
	} catch (err) {
		if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
			throw new Error(
				`Not a maxstack project (no ${CONFIG_FILENAME}): ${abs}\n  run "maxstack init" here first.`,
			)
		}
		throw err
	}
	const specDir = resolve(abs, SPEC_DIRNAME)
	return {
		root: abs,
		config,
		specDir,
		appPath: resolve(abs, config.appDir),
		spec: createFileSpecStore(specDir, {
			// The legacy `spec.json` → `spec/` migration rewrites the on-disk layout;
			// announce it so it isn't discovered only via `git status`.
			onMigrate: ({ from, to }) =>
				console.log(
					`· migrated legacy ${SPEC_FILENAME} → ${SPEC_DIRNAME}/ (removed ${from}, wrote ${to}/)`,
				),
		}),
	}
}

/** Serialize a project config to its on-disk `maxstack.json` form (tab-indented). */
export function serializeConfig(config: ProjectConfig): string {
	return `${JSON.stringify(config, null, '\t')}\n`
}

/** Write a project's `maxstack.json`. Used by `init` (scaffold) and `add` (record
 * an installed bundle). */
export async function saveConfig(
	root: string,
	config: ProjectConfig,
): Promise<void> {
	const { writeFile } = await import('node:fs/promises')
	await writeFile(resolve(root, CONFIG_FILENAME), serializeConfig(config))
}

const MILESTONE_LEAD_DAYS = 14

/** Today's date (UTC) as an ISO `YYYY-MM-DD` string. */
function todayISO(): string {
	return new Date().toISOString().slice(0, 10)
}

/** An ISO `YYYY-MM-DD` date `days` after today (UTC). */
function isoDateDaysFromNow(days: number): string {
	const d = new Date()
	d.setUTCDate(d.getUTCDate() + days)
	return d.toISOString().slice(0, 10)
}

/** Seed a fresh spec system from a title + description (a minimal valid PRD).
 * The description is a pitch, so it seeds only `context.tldr`; the problem
 * statement stays a neutral placeholder until the user authors one. */
export function seedSpec(name: string, description: string): SpecSystem {
	return newSpecSystem(
		minimalPRD({
			title: name,
			tldr: description || `${name} — a maxstack project.`,
			problem: `${name} models a small domain that grows change-by-change through the maxstack loop.`,
			northStar: 'Weekly active use',
			persona: 'The maintainer',
			differentiation:
				'Grown safely over time through typed spec-ops and never-clobber regeneration.',
			lastUpdated: todayISO(),
			milestoneDate: isoDateDaysFromNow(MILESTONE_LEAD_DAYS),
		}),
	)
}
