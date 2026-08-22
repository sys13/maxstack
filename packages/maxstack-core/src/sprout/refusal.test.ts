/**
 * The refusal contract, asserted as a table (#450).
 *
 * Every fact this suite checks is a pure function of a code, so none of it
 * stands up a database or provokes a real refusal — which is the point of
 * `refusal.ts` importing nothing. The boundary tests that check `api.ts` and
 * `mcp.ts` actually *use* these codes live beside those files; what is here is
 * the contract they are checked against.
 */

import { describe, expect, it } from 'vitest'
import {
	formatRefusal,
	REFUSAL_CATALOG,
	type RefusalCode,
	refusal,
	refusalStatus,
	retryAfterHeader,
} from './refusal.ts'

const CODES = Object.keys(REFUSAL_CATALOG) as RefusalCode[]

/**
 * The table, restated as the expectation. Written out longhand rather than
 * derived from the catalog: a test that reads the value it is asserting proves
 * only that the object exists, and this is the file that has to fail when
 * somebody changes a status or flips a fault.
 */
const EXPECTED: Record<
	RefusalCode,
	{ status: number; fault: string; retryable: boolean }
> = {
	empty_update: { status: 400, fault: 'caller', retryable: false },
	validation_failed: { status: 422, fault: 'caller', retryable: false },
	limit_exceeded: { status: 422, fault: 'policy', retryable: false },
	conflict: { status: 409, fault: 'caller', retryable: false },
	constraint_violation: { status: 422, fault: 'caller', retryable: false },
	forbidden: { status: 403, fault: 'policy', retryable: false },
	not_found: { status: 404, fault: 'caller', retryable: false },
	unknown_resource: { status: 404, fault: 'caller', retryable: false },
	unsupported_operation: { status: 422, fault: 'caller', retryable: false },
	rate_limited: { status: 429, fault: 'policy', retryable: true },
	selection_too_large: { status: 400, fault: 'caller', retryable: false },
	invalid_action_choice: { status: 400, fault: 'caller', retryable: false },
	unknown_action: { status: 404, fault: 'caller', retryable: false },
	internal: { status: 500, fault: 'platform', retryable: true },
}

describe('the refusal catalog', () => {
	it.each(CODES)('%s maps to its declared status, fault and retry', (code) => {
		const expected = EXPECTED[code]
		expect(refusalStatus(code)).toBe(expected.status)
		expect(REFUSAL_CATALOG[code].fault).toBe(expected.fault)
		expect(REFUSAL_CATALOG[code].retry.retryable).toBe(expected.retryable)
	})

	it('covers exactly the codes the table declares — no code without a row', () => {
		expect(CODES.sort()).toEqual(Object.keys(EXPECTED).sort())
	})

	it.each(CODES)('%s says what the caller may do next', (code) => {
		// `next` is the field most likely to rot into a lie, and an empty one is
		// the first way it rots. It is written once per code, here, which is the
		// only reason asserting it on all of them is meaningful.
		expect(REFUSAL_CATALOG[code].next.length).toBeGreaterThan(20)
	})
})

describe('fault and retry are independent', () => {
	it('a policy refusal can still clear by itself', () => {
		// The reason `retry` is its own field. A client reading only the 429 —
		// or only the `policy` fault — gives up on a refusal that lifts in an hour.
		const r = refusal('rate_limited', 'Too many requests')
		expect(r.fault).toBe('policy')
		expect(r.retry).toEqual({ retryable: true, after: 3600 })
	})

	it('a platform refusal is retryable but names no time', () => {
		const r = refusal('internal', 'Internal error')
		expect(r.fault).toBe('platform')
		expect(r.retry?.retryable).toBe(true)
		expect(r.retry?.after).toBeUndefined()
	})

	it('a forbidden refusal is policy and never retryable', () => {
		// Repeating the request with the same identity gets the same answer.
		const r = refusal('forbidden', 'Permission denied: update on book')
		expect(r.fault).toBe('policy')
		expect(r.retry?.retryable).toBe(false)
	})
})

describe('the envelope', () => {
	it('carries the message the throwing site wrote, unchanged', () => {
		expect(refusal('not_found', 'book 7 not found').message).toBe(
			'book 7 not found',
		)
	})

	it('omits `rule` rather than inventing one', () => {
		expect('rule' in refusal('not_found', 'gone')).toBe(false)
	})

	it('carries `rule` when the throw site named what refused', () => {
		expect(
			refusal('forbidden', 'no', { rule: 'access.book.update' }).rule,
		).toBe('access.book.update')
	})

	it('lets a caller-supplied delay override the declared one', () => {
		const r = refusal('rate_limited', 'slow down', { retryAfter: 90 })
		expect(r.retry).toEqual({ retryable: true, after: 90 })
	})
})

describe('Retry-After is a projection of the envelope, not a second decision', () => {
	it('is set when the refusal says when it clears', () => {
		expect(retryAfterHeader(refusal('rate_limited', 'x'))).toBe('3600')
	})

	it('is absent when the refusal is retryable but cannot say when', () => {
		// `Retry-After: 0` is an instruction to retry immediately — the opposite
		// of what an unbounded platform failure wants.
		expect(retryAfterHeader(refusal('internal', 'x'))).toBeUndefined()
	})

	it('is absent when the refusal does not clear at all', () => {
		expect(retryAfterHeader(refusal('forbidden', 'x'))).toBeUndefined()
	})
})

describe('the stderr/MCP rendering', () => {
	it('names the code, the fault, the rule and the retry', () => {
		const line = formatRefusal(
			refusal('forbidden', 'Permission denied: update on book', {
				rule: 'access.book.update',
			}),
		)
		expect(line).toContain('[forbidden]')
		expect(line).toContain('fault=policy')
		expect(line).toContain('rule=access.book.update')
		expect(line).toContain('retry=no')
	})

	it('states the wait when there is one', () => {
		expect(formatRefusal(refusal('rate_limited', 'x'))).toContain(
			'retry=after 3600s',
		)
	})

	it('omits the rule clause when nothing named a rule', () => {
		expect(formatRefusal(refusal('not_found', 'x'))).not.toContain('rule=')
	})
})
