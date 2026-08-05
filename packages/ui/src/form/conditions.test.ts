/**
 * @vitest-environment node
 *
 * No DOM in this file. The package default is `jsdom`, which costs
 * ~400ms of environment construction per file — the dominant term in this suite's
 * CPU, and the contention that starved a synchronous render past its timeout on a
 * 2-core runner. A test that never renders should not pay for a document.
 */
import { describe, expect, it } from 'vitest'
import { z } from 'zod'
import {
	type FieldCondition,
	getByPath,
	refineConditions,
	resolveConditions,
} from './conditions.ts'

describe('getByPath', () => {
	it('reads nested and array paths, undefined for missing segments', () => {
		const values = { a: { b: { c: 1 } }, list: [{ x: 9 }] }
		expect(getByPath(values, 'a.b.c')).toBe(1)
		expect(getByPath(values, 'list.0.x')).toBe(9)
		expect(getByPath(values, 'a.b.missing')).toBeUndefined()
		expect(getByPath(values, 'nope.deep')).toBeUndefined()
	})
})

describe('resolveConditions', () => {
	const conditions: FieldCondition[] = [
		{ field: 'reason', visible: (v) => v.status === 'rejected' },
		{ field: 'note', disabled: (v) => v.locked === true },
	]

	it('hides a field whose visible predicate is false', () => {
		const { hidden } = resolveConditions(conditions, { status: 'approved' })
		expect(hidden.has('reason')).toBe(true)
	})

	it('shows a field whose visible predicate is true', () => {
		const { hidden } = resolveConditions(conditions, { status: 'rejected' })
		expect(hidden.has('reason')).toBe(false)
	})

	it('flags disabled fields', () => {
		const { disabled } = resolveConditions(conditions, { locked: true })
		expect(disabled.has('note')).toBe(true)
	})

	it('is a no-op for undefined conditions', () => {
		const { hidden, disabled } = resolveConditions(undefined, {})
		expect(hidden.size).toBe(0)
		expect(disabled.size).toBe(0)
	})
})

describe('refineConditions', () => {
	const base = z.object({
		status: z.enum(['open', 'rejected']),
		reason: z.string().optional(),
	})

	it('returns the same schema when no condition is required', () => {
		const out = refineConditions(base, [
			{ field: 'reason', visible: () => true },
		])
		expect(out).toBe(base)
	})

	it('flags an empty conditionally-required field at its path', () => {
		const schema = refineConditions(base, [
			{ field: 'reason', required: (v) => v.status === 'rejected' },
		])
		const result = schema.safeParse({ status: 'rejected', reason: '' })
		expect(result.success).toBe(false)
		const issue = result.error?.issues.find(
			(i) => i.path.join('.') === 'reason',
		)
		expect(issue).toBeTruthy()
	})

	it('passes when the required condition is not met', () => {
		const schema = refineConditions(base, [
			{ field: 'reason', required: (v) => v.status === 'rejected' },
		])
		expect(schema.safeParse({ status: 'open' }).success).toBe(true)
	})

	it('passes when the required field is filled', () => {
		const schema = refineConditions(base, [
			{ field: 'reason', required: (v) => v.status === 'rejected' },
		])
		expect(
			schema.safeParse({ status: 'rejected', reason: 'spam' }).success,
		).toBe(true)
	})

	it('keeps the result a ZodObject (shape + def tag intact)', () => {
		const schema = refineConditions(base, [
			{ field: 'reason', required: () => true },
		])
		expect((schema as { shape?: unknown }).shape).toBeTruthy()
	})
})
