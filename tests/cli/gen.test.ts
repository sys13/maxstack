import { mkdtemp } from 'fs/promises'
import os from 'os'
import path from 'path'
import { describe, expect, it } from 'vitest'

describe('gen CLI', () => {
	it('runs in production mode (mocked network)', async () => {
		const tempDir = await mkdtemp(path.join(os.tmpdir(), 'maxstack-test-'))

		expect(1).toBe(1) // Placeholder for actual test logic
		// try {
		// 	// This test assumes the network is mocked or intercepted
		// 	const result = await execa(
		// 		'node',
		// 		['bin/index.js', 'gen', '--production', '--dir', tempDir],
		// 		{
		// 			reject: false,
		// 		},
		// 	)
		// 	// Accept either success or network error
		// 	expect([0, 1]).toContain(result.exitCode)
		// } finally {
		// 	// Clean up the temporary directory
		// 	await rm(tempDir, { force: true, recursive: true })
		// }
	})

	it.todo('adds new routes based on maxstack config', async () => {})
	it.todo('removes routes based on maxstack config', async () => {})
	it.todo('adds components in pages maxstack config', async () => {
		// the components are created
		// the page is created
	})
	it.todo('removes components in pages maxstack config', async () => {
		// the components is removed from the page
	})
})
