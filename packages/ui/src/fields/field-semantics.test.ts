/**
 * @vitest-environment node
 *
 * No DOM in this file. The package default is `jsdom`, which costs
 * ~400ms of environment construction per file — the dominant term in this suite's
 * CPU, and the contention that starved a synchronous render past its timeout on a
 * 2-core runner. A test that never renders should not pay for a document.
 */
import { describe, expect, it } from 'vitest'
import {
	detectFieldKind,
	detectInputWidget,
	humanizeLabel,
	type IntrospectedColumn,
	multilineHint,
	nameHint,
	specialtyHint,
} from './field-semantics.ts'

const col = (over: Partial<IntrospectedColumn>): IntrospectedColumn => ({
	name: 'x',
	type: 'string',
	...over,
})

describe('humanizeLabel', () => {
	it('title-cases snake_case and camelCase column names', () => {
		expect(humanizeLabel('first_name')).toBe('First Name')
		expect(humanizeLabel('firstName')).toBe('First Name')
		expect(humanizeLabel('id')).toBe('Id')
		expect(humanizeLabel('authorId')).toBe('Author Id')
		expect(humanizeLabel('blog_post')).toBe('Blog Post')
	})
})

describe('nameHint', () => {
	it('detects email, url, and image columns by name', () => {
		expect(nameHint('email')).toBe('email')
		expect(nameHint('contactEmail')).toBe('email')
		expect(nameHint('homepage')).toBe('url')
		expect(nameHint('website_url')).toBe('url')
		expect(nameHint('profileUrl')).toBe('url')
		expect(nameHint('avatarUrl')).toBe('image')
		expect(nameHint('avatar')).toBe('image')
		expect(nameHint('coverImage')).toBe('image')
	})

	it('returns null for plain names', () => {
		expect(nameHint('title')).toBeNull()
		expect(nameHint('name')).toBeNull()
		expect(nameHint('description')).toBeNull()
	})
})

describe('detectFieldKind', () => {
	it('maps scalar types directly', () => {
		expect(detectFieldKind(col({ type: 'boolean' }))).toBe('boolean')
		expect(detectFieldKind(col({ type: 'date' }))).toBe('date')
		expect(detectFieldKind(col({ type: 'number' }))).toBe('number')
		expect(detectFieldKind(col({ type: 'json' }))).toBe('json')
		expect(detectFieldKind(col({ name: 'title', type: 'string' }))).toBe('text')
	})

	it('detects enums from type, enumValues, or options', () => {
		expect(detectFieldKind(col({ type: 'enum' }))).toBe('enum')
		expect(
			detectFieldKind(col({ type: 'string', enumValues: ['a', 'b'] })),
		).toBe('enum')
		expect(
			detectFieldKind(
				col({
					type: 'string',
					meta: { options: [{ label: 'A', value: 'a' }] },
				}),
			),
		).toBe('enum')
	})

	it('honors metadata: isFile, markdown, reference', () => {
		expect(detectFieldKind(col({ meta: { isFile: true } }))).toBe('file')
		expect(
			detectFieldKind(col({ meta: { isFile: true, fileAccept: 'image/*' } })),
		).toBe('image')
		expect(
			detectFieldKind(col({ name: 'body', meta: { markdown: true } })),
		).toBe('markdown')
		expect(
			detectFieldKind(
				col({ name: 'authorId', references: { table: 'user', column: 'id' } }),
			),
		).toBe('reference')
	})

	it('falls back to name heuristics for string columns', () => {
		expect(detectFieldKind(col({ name: 'email', type: 'string' }))).toBe(
			'email',
		)
		expect(detectFieldKind(col({ name: 'homepage', type: 'string' }))).toBe(
			'url',
		)
		expect(detectFieldKind(col({ name: 'avatarUrl', type: 'string' }))).toBe(
			'image',
		)
	})

	it('metadata wins over the name heuristic', () => {
		// A column named `avatarUrl` but flagged markdown is markdown, not image.
		expect(
			detectFieldKind(col({ name: 'avatarUrl', meta: { markdown: true } })),
		).toBe('markdown')
	})

	// Issue #345 — the name decided the widget and nothing could argue with it.
	// An explicit format is the escape hatch, and it has to work in BOTH
	// directions or `format: 'number'` would fix the read side and leave the form
	// still editing with stars.
	it('an explicit number format overrides the name heuristic both ways', () => {
		const named = { name: 'rating', type: 'number' } as const
		expect(detectFieldKind(col({ ...named, meta: { format: 'number' } }))).toBe(
			'number',
		)
		expect(
			detectInputWidget(col({ ...named, meta: { format: 'number' } })),
		).toBeNull()
		expect(
			detectFieldKind(
				col({
					name: 'imdbRating',
					type: 'number',
					meta: { format: 'percent' },
				}),
			),
		).toBe('number')
		// …and the other direction still promotes a name the heuristic misses.
		expect(
			detectFieldKind(
				col({ name: 'score', type: 'number', meta: { format: 'rating' } }),
			),
		).toBe('rating')
		expect(
			detectInputWidget(
				col({ name: 'score', type: 'number', meta: { format: 'rating' } }),
			),
		).toBe('rating')
	})

	it('detects specialty kinds from format and name (task 39)', () => {
		expect(detectFieldKind(col({ meta: { format: 'color' } }))).toBe('color')
		expect(
			detectFieldKind(
				col({ name: 'score', type: 'number', meta: { format: 'rating' } }),
			),
		).toBe('rating')
		expect(detectFieldKind(col({ name: 'brandColor' }))).toBe('color')
		expect(detectFieldKind(col({ name: 'apiPassword' }))).toBe('password')
		expect(detectFieldKind(col({ name: 'latlng' }))).toBe('geo')
		expect(detectFieldKind(col({ name: 'rating', type: 'number' }))).toBe(
			'rating',
		)
		expect(
			detectFieldKind(col({ name: 'durationSeconds', type: 'number' })),
		).toBe('duration')
		// A plain number/string with no signal is unchanged.
		expect(detectFieldKind(col({ name: 'count', type: 'number' }))).toBe(
			'number',
		)
	})
})

describe('specialtyHint', () => {
	it('detects the long-tail widgets by name', () => {
		expect(specialtyHint('password')).toBe('password')
		expect(specialtyHint('apiPassword')).toBe('password')
		expect(specialtyHint('brand_color')).toBe('color')
		expect(specialtyHint('bodyHtml')).toBe('richtext')
		expect(specialtyHint('coordinates')).toBe('geo')
		expect(specialtyHint('latlng')).toBe('geo')
		expect(specialtyHint('rating')).toBe('rating')
		expect(specialtyHint('duration')).toBe('duration')
		expect(specialtyHint('title')).toBeNull()
	})
})

describe('detectInputWidget', () => {
	it('upgrades markdown / file / image from metadata', () => {
		expect(detectInputWidget(col({ meta: { markdown: true } }))).toBe(
			'markdown',
		)
		expect(detectInputWidget(col({ meta: { isFile: true } }))).toBe('file')
		expect(
			detectInputWidget(col({ meta: { isFile: true, fileAccept: 'image/*' } })),
		).toBe('image')
		expect(
			detectInputWidget(col({ name: 'avatar', meta: { isFile: true } })),
		).toBe('image')
	})

	it('upgrades specialty widgets from format, name, and json type', () => {
		expect(detectInputWidget(col({ meta: { format: 'color' } }))).toBe('color')
		expect(detectInputWidget(col({ meta: { format: 'slider' } }))).toBe(
			'slider',
		)
		expect(detectInputWidget(col({ type: 'json' }))).toBe('json')
		expect(detectInputWidget(col({ name: 'password' }))).toBe('password')
		expect(detectInputWidget(col({ name: 'geoPoint' }))).toBe('geo')
	})

	it('returns null for plain and structural columns (schema drives those)', () => {
		expect(detectInputWidget(col({ name: 'title', type: 'string' }))).toBeNull()
		expect(detectInputWidget(col({ name: 'count', type: 'number' }))).toBeNull()
		// A reference/enum is never a specialty widget even if the name matches.
		expect(
			detectInputWidget(
				col({ name: 'color', type: 'enum', enumValues: ['red', 'blue'] }),
			),
		).toBeNull()
		expect(
			detectInputWidget(
				col({ name: 'ownerId', references: { table: 'user', column: 'id' } }),
			),
		).toBeNull()
	})

	// #285: a tasting note, a bio and an address are all `string` — there is no
	// seventh canonical type — and all edited in a single-line input.
	it('edits prose-shaped string columns in a textarea', () => {
		expect(detectInputWidget(col({ name: 'tastingNotes' }))).toBe('textarea')
		expect(detectInputWidget(col({ name: 'description' }))).toBe('textarea')
		expect(detectInputWidget(col({ name: 'shipping_address' }))).toBe(
			'textarea',
		)
		expect(detectInputWidget(col({ name: 'bio' }))).toBe('textarea')
		// Not prose: a name, and a `notes`-named column that isn't a string.
		expect(detectInputWidget(col({ name: 'name' }))).toBeNull()
		expect(detectInputWidget(col({ name: 'notes', type: 'number' }))).toBeNull()
	})

	it('lets metadata override the multiline inference in both directions', () => {
		expect(
			detectInputWidget(col({ name: 'notes', meta: { multiline: false } })),
		).toBeNull()
		expect(
			detectInputWidget(col({ name: 'title', meta: { multiline: true } })),
		).toBe('textarea')
		// A declared richer editor still wins over plain prose.
		expect(
			detectInputWidget(col({ name: 'notes', meta: { markdown: true } })),
		).toBe('markdown')
	})
})

describe('multilineHint', () => {
	it('tokenizes camelCase / snake_case before matching', () => {
		expect(multilineHint('tastingNotes')).toBe(true)
		expect(multilineHint('short_description')).toBe(true)
		expect(multilineHint('title')).toBe(false)
	})
})
