/**
 * How the CLI was launched decides what the scaffolded configs may name. The
 * case that matters is npx: there is no `maxstack` on PATH, so a bare one
 * produces a project whose MCP server and edit guard both fail silently.
 */

import { describe, expect, it } from 'vitest'
import { cliInvocation, launchMode } from './invocation.ts'

describe('launchMode', () => {
	it('detects npx from the install path', () => {
		// Where `npm exec` unpacks a package it had to fetch.
		expect(
			launchMode('/Users/x/.npm/_npx/4f8a1c/node_modules/maxstack', {}),
		).toBe('npx')
		expect(
			launchMode('C:\\Users\\x\\AppData\\npm-cache\\_npx\\ab\\node_modules\\maxstack', {}),
		).toBe('npx')
	})

	it('detects npx over an already-installed package from the env', () => {
		// `npx maxstack` with a local devDependency re-uses node_modules rather
		// than a `_npx` entry: `maxstack` is on PATH for that one command and gone
		// afterwards, which is exactly as broken for a config written now.
		expect(
			launchMode('/work/app/node_modules/maxstack', { npm_command: 'exec' }),
		).toBe('npx')
	})

	it('treats a global install and a checkout as direct', () => {
		expect(launchMode('/usr/local/lib/node_modules/maxstack', {})).toBe('direct')
		expect(launchMode('/Users/x/prj/maxstack/maxstack/apps/maxstack', {})).toBe(
			'direct',
		)
		// `npm run <script>` sets npm_command too, and there a local bin *is* on
		// PATH — so the env alone must not be read as npx.
		expect(
			launchMode('/usr/local/lib/node_modules/maxstack', {
				npm_command: 'run-script',
			}),
		).toBe('direct')
	})
})

describe('cliInvocation', () => {
	it('pins the version under npx', () => {
		// Unpinned `npx maxstack` would drift to whatever `latest` is months from
		// now — and is the form that prompts for install consent, which inside a
		// client's stdio handshake is indistinguishable from a hung server.
		expect(cliInvocation('npx', '0.11.6')).toEqual({
			command: 'npx',
			prefix: ['-y', 'maxstack@0.11.6'],
			shell: 'npx -y maxstack@0.11.6',
		})
	})

	it('leaves a direct install invoking `maxstack` by name', () => {
		expect(cliInvocation('direct', '0.11.6')).toEqual({
			command: 'maxstack',
			prefix: [],
			shell: 'maxstack',
		})
	})
})
