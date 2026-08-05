/**
 * Headless demo-data loader — `maxstack demo [dir]` spawns this
 * script the same way `maxstack dev` spawns the web app itself
 * (`apps/maxstack/src/commands/harness.ts`'s `demoCommand`/`devCommand`),
 * pointed at the project's data dir via `MAXSTACK_DATA_DIR`. Runs the exact
 * `seedDemoData()` the onboarding wizard's "Load demo data" button and the
 * empty-state CTA call (`apps/web/app/sprout.server.ts`) — one seed
 * mechanism, reachable from both the UI and the CLI — then exits; a one-shot
 * seed has no need for a long-running server.
 *
 * Loaded through Vite's SSR module runner (not plain `node`): `sprout.server`
 * and its graph use extensionless relative imports and the `~/...` alias,
 * both resolved by the app's own `vite.config.ts` (the same resolution
 * `react-router dev`/`build` already rely on) — plain Node ESM resolution
 * requires explicit extensions and knows nothing of the alias, so it can't
 * load this module graph directly.
 *
 * Run:  pnpm --filter @maxstack/web demo:seed  (needs MAXSTACK_DATA_DIR set)
 */

import { createServer } from 'vite'

if (!process.env.MAXSTACK_DATA_DIR) {
	console.error(
		'MAXSTACK_DATA_DIR is not set — run this via `maxstack demo <dir>`.',
	)
	process.exit(1)
}

const server = await createServer({
	root: import.meta.dirname.replace(/\/scripts$/, ''),
	server: { middlewareMode: true },
	appType: 'custom',
})

try {
	const mod = await server.ssrLoadModule('/app/sprout.server.ts')
	const { clearDemoData, getSprout, seedDemoData } = mod as {
		getSprout: () => Promise<{ backend: { dispose(): Promise<void> } }>
		seedDemoData: () => Promise<{ seeded: boolean; resources: string[] }>
		clearDemoData: () => Promise<{
			cleared: number
			resources: string[]
			missing: number
		}>
	}

	// `--clear` is the same one-shot shape in reverse, so it rides
	// the same entry rather than a second vite boot of the same module graph.
	if (process.argv.includes('--clear')) {
		const result = await clearDemoData()
		console.log(
			result.cleared > 0
				? `✓ removed ${result.cleared} demo row(s)${
						result.resources.length ? ` (${result.resources.join(', ')})` : ''
					}`
				: '· no demo rows to remove — nothing was tracked as demo data',
		)
		if (result.missing > 0) {
			console.log(`· ${result.missing} tracked row(s) were already gone`)
		}
	} else {
		const result = await seedDemoData()
		if (result.seeded) {
			console.log(
				result.resources.length > 0
					? `✓ demo data loaded (${result.resources.join(', ')})`
					: '✓ demo data loaded',
			)
		} else {
			console.log('· nothing to seed — every resource already has data')
		}
	}

	const { backend } = await getSprout()
	await backend.dispose()
} finally {
	await server.close()
}

process.exit(0)
