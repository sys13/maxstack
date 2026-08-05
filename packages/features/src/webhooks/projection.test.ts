/**
 * Issue #185: *"payload contents must be scoped by declared field projection."*
 *
 * The property under test is **default-deny**, and the way to test default-deny
 * is to add a field nobody asked for and assert it does not arrive. That is the
 * real-world failure: an entity grows a `internalNotes` column and every
 * subscription created a year ago silently starts receiving it.
 */

import { describe, expect, it } from 'vitest'
import { isNeverSent, projectionErrors, projectPayload } from './projection.ts'

const row = {
	id: 'inv_1',
	total: 100,
	status: 'paid',
	internalNotes: 'chase this customer',
	customerSsn: '000-00-0000',
}

describe('default-deny', () => {
	it('sends only the named fields', () => {
		const { data, projected } = projectPayload('invoice', row, [
			{ resource: 'invoice', fields: ['id', 'total'] },
		])
		expect(data).toEqual({ id: 'inv_1', total: 100 })
		expect(projected).toBe(true)
	})

	it('a field added to the entity later does NOT reach an existing subscription', () => {
		// The whole point. The projection was written before `internalNotes`
		// existed; adding the column must not widen what a subscriber receives.
		const projection = [{ resource: 'invoice', fields: ['id', 'total'] }]
		const widened = { ...row, internalNotes: 'new column', secretPlan: 'x' }
		expect(projectPayload('invoice', widened, projection).data).toEqual({
			id: 'inv_1',
			total: 100,
		})
	})

	it('sends identifiers only when no projection covers the resource', () => {
		// A subscription created before projections existed keeps working — it
		// still learns that the event happened and which row it was about — and
		// stops receiving field data nobody deliberately granted.
		const { data, projected } = projectPayload('invoice', row, [])
		expect(data).toEqual({ id: 'inv_1' })
		expect(projected).toBe(false)
		expect(projectPayload('invoice', row, undefined).data).toEqual({
			id: 'inv_1',
		})
	})

	it('handles a non-object payload without inventing one', () => {
		expect(projectPayload('invoice', null, undefined).data).toEqual({})
		expect(projectPayload('invoice', [1, 2], undefined).data).toEqual({})
	})
})

describe('the never-sent list sits on top of the allowlist', () => {
	it('refuses a projection that names a secret-shaped field', () => {
		const errors = projectionErrors([
			{ resource: 'user', fields: ['id', 'passwordHash'] },
		])
		expect(errors.join()).toMatch(/never sent to a third party/)
	})

	it('drops a never-sent field even if one slipped into a stored projection', () => {
		// Belt and braces: the declaration check runs at subscribe time, but a row
		// written before that check existed must not leak on delivery either.
		const { data } = projectPayload('user', { id: 'u1', apiKey: 'sk_live' }, [
			{ resource: 'user', fields: ['id', 'apiKey'] },
		])
		expect(data).toEqual({ id: 'u1' })
	})

	it('matches across naming styles and suffixes', () => {
		for (const key of [
			'password',
			'password_hash',
			'passwordHash',
			'PasswordHash',
			'stripeApiKey',
			'user_secret',
			'refreshToken',
		])
			expect(isNeverSent(key)).toBe(true)
		for (const key of ['id', 'total', 'title', 'tokenCount'])
			expect(isNeverSent(key)).toBe(false)
	})
})

describe('declaration validation', () => {
	it('refuses a projection that names no fields', () => {
		expect(
			projectionErrors([{ resource: 'invoice', fields: [] }]).join(),
		).toMatch(/names no fields/)
	})

	it('refuses two projections for the same resource', () => {
		expect(
			projectionErrors([
				{ resource: 'invoice', fields: ['id'] },
				{ resource: 'invoice', fields: ['total'] },
			]).join(),
		).toMatch(/duplicate projection/)
	})

	it('accepts an ordinary declaration', () => {
		expect(
			projectionErrors([{ resource: 'invoice', fields: ['id', 'total'] }]),
		).toEqual([])
	})
})
