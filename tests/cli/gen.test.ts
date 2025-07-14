import { execa } from 'execa'
import { mkdtemp, rm } from 'fs/promises'
import os from 'os'
import path from 'path'
import { describe, expect, it } from 'vitest'

// gen CLI tests

describe('gen CLI', () => {
	it('runs and generates basic database schema when no config exists', async () => {
		// Create a temporary directory for testing
		const tempDir = await mkdtemp(path.join(os.tmpdir(), 'maxstack-test-'))

		try {
			// Run the CLI with the gen command
			const result = await execa(
				'node',
				['bin/index.js', 'gen', '--dir', tempDir],
				{
					reject: false,
				},
			)
			expect(result.exitCode).toBe(0)
			expect(result.stdout).toMatch(/Completed successfully/)
			// Should create basic database schema files
			expect(result.stdout).toMatch(
				new RegExp(
					`Created app/db/schema/user.ts in ${tempDir.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`,
				),
			)
		} finally {
			// Clean up the temporary directory
			await rm(tempDir, { force: true, recursive: true })
		}
	})

	it('generates pages and models from configuration', async () => {
		// Create a temporary directory for testing
		const tempDir = await mkdtemp(path.join(os.tmpdir(), 'maxstack-test-'))

		try {
			// Create a test config
			const configContent = `import type { MAXConfig } from '.maxstack/types'

export default {
	name: 'TestApp',
	description: 'A test application',
	standardFeatures: ['blog'],
	pages: [
		{
			name: 'Home',
			description: 'The home page',
			routePath: '/',
			authRequired: false,
		},
	],
} as const satisfies MAXConfig`

			const typesContent = `export type MAXConfig = {
	name: string
	description: string
	standardFeatures?: string[]
	pages?: { name: string; description?: string; routePath?: string; authRequired?: boolean }[]
}`

			// Write the config files
			await execa('mkdir', ['-p', path.join(tempDir, '.maxstack')])

			await execa('sh', [
				'-c',
				`cat > ${path.join(tempDir, 'maxstack.tsx')} << 'EOF'
${configContent}
EOF`,
			])

			await execa('sh', [
				'-c',
				`cat > ${path.join(tempDir, '.maxstack', 'types.tsx')} << 'EOF'
${typesContent}
EOF`,
			])

			// Run the CLI from the temp directory
			const result = await execa(
				'node',
				[path.join(process.cwd(), 'bin/index.js'), 'gen'],
				{
					reject: false,
					cwd: tempDir,
				},
			)

			expect(result.exitCode).toBe(0)
			expect(result.stdout).toMatch(/Completed successfully/)
			expect(result.stdout).toMatch(/Found pages in configuration/)
			expect(result.stdout).toMatch(/Found blog in standardFeatures/)
			expect(result.stdout).toMatch(
				new RegExp(
					`Created app/routes/home.tsx in ${tempDir.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`,
				),
			)
			expect(result.stdout).toMatch(
				new RegExp(
					`Created app/db/schema/blog.ts in ${tempDir.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`,
				),
			)
		} finally {
			// Clean up the temporary directory
			await rm(tempDir, { force: true, recursive: true })
		}
	})
})
