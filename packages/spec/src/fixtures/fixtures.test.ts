import { describe, expect, it } from 'vitest'
import { validatePRD } from '../prd/prd.schema.ts'
import { blogPRD, cardstackPRD, tasklyPRD, todotrackerPRD } from './index.ts'

describe('PRD fixtures', () => {
	it.each([
		['cardstack', cardstackPRD],
		['taskly', tasklyPRD],
		['todotracker', todotrackerPRD],
		['blog', blogPRD],
	])('%s passes referential-integrity validation', (_name, prd) => {
		expect(() => validatePRD(prd)).not.toThrow()
	})
})
