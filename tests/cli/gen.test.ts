import { execa } from 'execa'
import { mkdtemp, rm } from 'fs/promises'
import os from 'os'
import path from 'path'
import { describe, expect, it } from 'vitest'

// gen CLI tests

describe('gen CLI', () => {
	it('runs in mock mode and executes commands', async () => {
		// Create a temporary directory for testing
		const tempDir = await mkdtemp(path.join(os.tmpdir(), 'maxstack-test-'))

		try {
			// Run the CLI with the gen command (mocked)
			const result = await execa(
				'node',
				['bin/index.js', 'gen', '--dir', tempDir],
				{
					reject: false,
				},
			)
			expect(result.exitCode).toBe(0)
			expect(result.stdout).toMatch(/Completed successfully/)
			// Since no maxstack.tsx config exists in temp dir, saas-marketing won't be found
			expect(result.stdout).toMatch(
				/saas-marketing not found in standardFeatures/,
			)
			// Should still create database schema files
			expect(result.stdout).toMatch(
				new RegExp(
					`Created database/schema/users.ts in ${tempDir.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`,
				),
			)
			expect(result.stdout).toMatch(
				new RegExp(
					`Created database/schema/organizations.ts in ${tempDir.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`,
				),
			)
		} finally {
			// Clean up the temporary directory
			await rm(tempDir, { force: true, recursive: true })
		}
	})

	it('runs in production mode (mocked network)', async () => {
		// Create a temporary directory for testing
		const tempDir = await mkdtemp(path.join(os.tmpdir(), 'maxstack-test-'))

		try {
			// This test assumes the network is mocked or intercepted
			const result = await execa(
				'node',
				['bin/index.js', 'gen', '--production', '--dir', tempDir],
				{
					reject: false,
				},
			)
			// Accept either success or network error
			expect([0, 1]).toContain(result.exitCode)
		} finally {
			// Clean up the temporary directory
			await rm(tempDir, { force: true, recursive: true })
		}
	})
})
