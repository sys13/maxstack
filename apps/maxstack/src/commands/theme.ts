/**
 * `maxstack theme <preset> [--accent #hex] [--radius lg] …` — terminal-native
 * sugar over the `theme.set` op, the same pattern as
 * `add-entity` over `data.addEntity`. "Make it beautiful" from the terminal in
 * one line; the JSON op stays the honest underlying primitive.
 *
 * No `--accept`/`--gen`: the theme is not a provenanced row (nothing to
 * review) and it's resolved by the runtime at request time (nothing to
 * regenerate) — the change is live on the next page load.
 */

import { type SpecOp, THEME_PRESETS, type ThemeSpec } from '@maxstack/spec'
import { landOp } from '../lib/land.ts'
import { resolveActor, resolveOrigin } from '../lib/origin.ts'
import { loadProject } from '../lib/project.ts'

interface ThemeOptions {
	accent?: string
	radius?: string
	density?: string
	font?: string
	typeScale?: string
	/** `--origin ai|human`; unset means "detect". */
	origin?: string
	/** `--agent <name>`; unset means "detect, else absent". */
	agent?: string
}

export async function themeCommand(
	dir: string | undefined,
	preset: string,
	opts: ThemeOptions,
): Promise<void> {
	// Compile flags → the op payload verbatim; `landOp` runs the shared
	// validator, so a bad preset/enum/hex fails with the op's structured errors.
	const theme = {
		preset,
		accent: opts.accent,
		radius: opts.radius,
		density: opts.density,
		font: opts.font,
		typeScale: opts.typeScale,
	} as unknown as ThemeSpec
	const op: SpecOp = { op: 'theme.set', args: { theme } }

	const project = await loadProject(dir ?? '.')
	const result = await landOp(project, op, {
		origin: resolveOrigin(opts.origin),
		actor: resolveActor({ path: 'cli-theme', agent: opts.agent }),
	})

	const applied = result.spec.theme
	const extras = Object.entries(applied ?? {})
		.filter(([k, v]) => k !== 'preset' && v !== undefined)
		.map(([k, v]) => `${k} ${v}`)
		.join(' · ')
	console.log(
		`✔ theme set to "${preset}"${extras ? ` (${extras})` : ''} — live on the next page load`,
	)
	console.log(`  presets: ${THEME_PRESETS.join(' · ')}`)
}
