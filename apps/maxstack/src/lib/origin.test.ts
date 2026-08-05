/**
 * Issue #141 — `origin` records the author, not the transport. These lock the
 * resolution order (flag > env > detection > human) so an agent shelling out to
 * the CLI can't silently log its work as hand-authored.
 */

import { describe, expect, it } from 'vitest'
import { resolveOrigin } from './origin.ts'

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
