/**
 * Issue #141 — `origin` records the author, not the transport. These lock the
 * resolution order (flag > env > detection > human) so an agent shelling out to
 * the CLI can't silently log its work as hand-authored.
 */

import { describe, expect, it } from 'vitest'
import { resolveActor, resolveAgentIdentity, resolveOrigin } from './origin.ts'

describe('resolveOrigin', () => {
	it('defaults to human in a plain shell', () => {
		expect(resolveOrigin(undefined, {})).toBe('human')
	})

	it('detects an agent-driven shell', () => {
		expect(resolveOrigin(undefined, { CLAUDECODE: '1' })).toBe('ai')
		expect(resolveOrigin(undefined, { CLAUDE_CODE_ENTRYPOINT: 'cli' })).toBe(
			'ai',
		)
	})

	it('ignores the "explicitly off" spellings of the detection vars', () => {
		for (const off of ['0', 'false', '', '  ']) {
			expect(resolveOrigin(undefined, { CLAUDECODE: off })).toBe('human')
		}
	})

	it('lets MAXSTACK_ORIGIN override detection (either way)', () => {
		expect(resolveOrigin(undefined, { MAXSTACK_ORIGIN: 'ai' })).toBe('ai')
		expect(
			resolveOrigin(undefined, { MAXSTACK_ORIGIN: 'human', CLAUDECODE: '1' }),
		).toBe('human')
	})

	it('lets --origin win over both env vars', () => {
		expect(
			resolveOrigin('human', { MAXSTACK_ORIGIN: 'ai', CLAUDECODE: '1' }),
		).toBe('human')
		expect(resolveOrigin('ai', { MAXSTACK_ORIGIN: 'human' })).toBe('ai')
	})

	it('accepts surrounding whitespace and casing', () => {
		expect(resolveOrigin(' AI ', {})).toBe('ai')
		expect(resolveOrigin(undefined, { MAXSTACK_ORIGIN: 'Human' })).toBe('human')
	})

	it('rejects an unknown value loudly, naming the source', () => {
		expect(() => resolveOrigin('robot', {})).toThrow(/--origin "robot"/)
		expect(() => resolveOrigin(undefined, { MAXSTACK_ORIGIN: 'robot' })).toThrow(
			/MAXSTACK_ORIGIN "robot"/,
		)
	})

	it('treats an empty MAXSTACK_ORIGIN as unset rather than invalid', () => {
		expect(resolveOrigin(undefined, { MAXSTACK_ORIGIN: '' })).toBe('human')
	})
})

/**
 * Issue #279 — the identity two-thirds, split out of `resolveActor` so a host
 * that is not the CLI can read it. `surface`/`path` are the write path's own
 * facts; everything here comes from the environment the process was handed.
 */
describe('resolveAgentIdentity', () => {
	it('records nothing rather than a placeholder in a plain shell', () => {
		expect(resolveAgentIdentity({}, {})).toEqual({})
	})

	it('resolves --agent > MAXSTACK_AGENT > a recognised harness', () => {
		const env = { MAXSTACK_AGENT: 'from-env', CLAUDECODE: '1' }
		expect(resolveAgentIdentity({ agent: 'from-flag' }, env).agent).toBe(
			'from-flag',
		)
		expect(resolveAgentIdentity({}, env).agent).toBe('from-env')
		expect(resolveAgentIdentity({}, { CLAUDECODE: '1' }).agent).toBe(
			'claude-code',
		)
	})

	it('carries session and keyId through, trimmed, blank treated as absent', () => {
		expect(
			resolveAgentIdentity(
				{},
				{ MAXSTACK_SESSION: ' sess-1 ', MAXSTACK_KEY_ID: 'key-1' },
			),
		).toEqual({ session: 'sess-1', keyId: 'key-1' })
		expect(
			resolveAgentIdentity({}, { MAXSTACK_SESSION: '  ', MAXSTACK_KEY_ID: '' }),
		).toEqual({})
	})

	it('is exactly the non-surface part of resolveActor', () => {
		// The split must not become a second derivation: whatever a CLI op records
		// about *who*, the MCP host records about the same shell.
		const env = {
			CLAUDECODE: '1',
			MAXSTACK_SESSION: 'sess-1',
			MAXSTACK_KEY_ID: 'key-1',
		}
		const { surface, path, ...identity } = resolveActor({ path: 'cli-op' }, env)
		expect(surface).toBe('cli')
		expect(path).toBe('cli-op')
		expect(identity).toEqual(resolveAgentIdentity({}, env))
	})
})
