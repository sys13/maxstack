/**
 * Browser smoke tier — the PR-tier production-safety gate runs
 * `e2e/smoke.spec.ts` against the real production build (`react-router build`
 * + `react-router-serve`), not the dev server, so what CI exercises is what
 * deploys. Run locally with `pnpm --filter @maxstack/web test:e2e` (build
 * first: `pnpm --filter @maxstack/web build`).
 */

import { defineConfig } from '@playwright/test'

const PORT = Number(process.env.SMOKE_PORT ?? 4173)

export default defineConfig({
	testDir: './e2e',
	retries: process.env.CI ? 1 : 0,
	reporter: process.env.CI
		? [['list'], ['html', { open: 'never' }]]
		: [['list']],
	use: {
		baseURL: `http://127.0.0.1:${PORT}`,
		trace: 'retain-on-failure',
	},
	projects: [{ name: 'chromium', use: { browserName: 'chromium' } }],
	webServer: {
		command: 'pnpm start',
		url: `http://127.0.0.1:${PORT}/health`,
		reuseExistingServer: !process.env.CI,
		timeout: 90_000,
		env: { PORT: String(PORT) },
	},
})
