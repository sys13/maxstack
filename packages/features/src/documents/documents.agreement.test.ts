/**
 * The two halves of the document vocabulary must agree.
 *
 * `@maxstack/spec`'s `printableFieldTypes` / `DOCUMENT_PAGE_SIZES` /
 * `DOCUMENT_FORMATS` / `MAX_DOCUMENT_TABLE_ROWS` are what a declaration is
 * **validated** against. `@maxstack/core`'s copies are what the renderer
 * **acts** on. They cannot be one list — `@maxstack/core` does not depend on
 * `@maxstack/spec` (`boundaries.config.json`, on purpose, so the spec→Sprout
 * bridge stays a translation rather than a coupling) — so the duplication is
 * deliberate and this file is the price of it.
 *
 * The drift is invisible and asymmetric here too, which is why it is worth a
 * file, and the two directions fail in different places:
 *
 *  - A type in **spec but not core** means a template that validates cleanly
 *    renders that field through the string fallback, so a `json` column would
 *    print its punctuation onto a customer's invoice.
 *  - A page size in **core but not spec** is dead code that will eventually be
 *    referenced by a hand-edited `documents.json` nothing checks.
 *  - A row bound that differs means the renderer's truncation note reports a
 *    number the validator never agreed to.
 *
 * `@maxstack/features` is the lowest package permitted to import both, which is
 * the same reason `search/search.agreement.test.ts` lives here.
 */

import {
	MAX_DOCUMENT_TABLE_ROWS as CORE_MAX_TABLE_ROWS,
	DOCUMENT_VALUE_TYPES,
} from '@maxstack/core'
import {
	DOCUMENT_FORMATS,
	DOCUMENT_PAGE_SIZES,
	printableFieldTypes,
	MAX_DOCUMENT_TABLE_ROWS as SPEC_MAX_TABLE_ROWS,
} from '@maxstack/spec'
import { describe, expect, it } from 'vitest'
import { DOCUMENT_CONTENT_TYPES } from './index.ts'

describe('the spec and core document vocabularies', () => {
	it('name exactly the same printable field types', () => {
		expect([...DOCUMENT_VALUE_TYPES].sort()).toEqual(
			[...printableFieldTypes].sort(),
		)
	})

	it('agree on how many related rows a table section prints', () => {
		// The renderer prints "showing the first N of M"; the validator is what
		// makes N a promise rather than a surprise.
		expect(CORE_MAX_TABLE_ROWS).toBe(SPEC_MAX_TABLE_ROWS)
	})

	it('gives every declarable format a content type', () => {
		expect(Object.keys(DOCUMENT_CONTENT_TYPES).sort()).toEqual(
			[...DOCUMENT_FORMATS].sort(),
		)
	})

	it('keeps the paper vocabulary to the two sizes printers actually hold', () => {
		expect([...DOCUMENT_PAGE_SIZES]).toEqual(['a4', 'letter'])
	})
})
