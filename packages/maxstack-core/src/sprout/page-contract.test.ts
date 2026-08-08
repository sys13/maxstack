/**
 * The page surface's contract — `api-contract.test.ts`'s sibling, one level up.
 *
 * The session that filed #376 could reach `/api/<resource>` in full and the
 * page's own routes not at all, so it grepped rendered HTML for `href=` and
 * then guessed twice, wrongly. These pin the two properties that make
 * publishing this worth anything: it names the URLs the *app itself* links to,
 * and the runtime's refusals are composed from the same list, so a caller
 * corrected by a 4xx and a caller reading `query_spec {section:"pages"}` are
 * told the same thing.
 */

import { describe, expect, it } from 'vitest'
import {
	acceptedBodies,
	allowedMethods,
	pageContract,
	pageCreatePath,
	pageRecordPath,
} from './page-contract.ts'

const decks = () => pageContract({ route: '/decks', resource: 'deck' })

const requests = (route: string, resource: string | null): string[] =>
	pageContract({ route, resource }).endpoints.map((e) => e.request)

describe('the page contract', () => {
	it('names the routes the app links to, not the REST ones', () => {
		expect(requests('/decks', 'deck')).toEqual([
			'GET /decks',
			'GET /decks/new',
			'POST /decks/new',
			'POST /decks/parse',
			'GET /decks/:id',
			'POST /decks/:id',
			'POST /decks/:id',
		])
	})

	it('is a single GET for a page with no backing entity', () => {
		// Nothing to create, update or delete — publishing write URLs it does not
		// serve would be the same defect pointed the other way.
		expect(requests('/about', null)).toEqual(['GET /about'])
	})

	it('joins the root page without producing a protocol-relative URL', () => {
		// The root page's slug is the empty string; interpolating it yields
		// `//new`, which a browser reads as `https://new/`.
		expect(requests('/', 'deck')).toContain('POST /new')
		expect(requests('/', 'deck')).toContain('POST /:id')
		expect(pageRecordPath('/')).toBe('/:id')
		expect(pageCreatePath('/')).toBe('/new')
	})

	it('keeps a multi-segment declared route whole', () => {
		// `/app/decks` is as legitimate a declaration as `/decks`, and every
		// benchmark page uses two segments.
		expect(pageRecordPath('/app/decks')).toBe('/app/decks/:id')
	})

	it('distinguishes update from delete by content type, and says so', () => {
		// The discriminator is invisible from the rendered HTML, which is exactly
		// what #376's session had to work from.
		const accepts = acceptedBodies(decks(), 'POST /decks/:id')
		expect(accepts).toMatch(/application\/json.*to update the deck/)
		expect(accepts).toMatch(/intent=delete.*to delete the deck/)
	})

	it('points a programmatic caller at the REST delete it already has', () => {
		// The guess was `DELETE /decks/:id`. There *is* a verb-shaped delete; it
		// is one layer over, and naming it costs the caller no further probing.
		expect(acceptedBodies(decks(), 'POST /decks/:id')).toContain(
			'DELETE /api/deck/:id',
		)
	})

	it('derives `Allow` from the endpoint list rather than restating it', () => {
		expect(allowedMethods(decks(), '/decks/:id')).toBe('GET, POST')
		expect(allowedMethods(decks(), '/decks/parse')).toBe('POST')
	})

	it('says a path is not served rather than inventing an accepted shape', () => {
		expect(acceptedBodies(decks(), 'PATCH /decks/:id')).toBe(
			'`PATCH /decks/:id` is not served.',
		)
	})
})
