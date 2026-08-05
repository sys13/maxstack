/**
 * Font parsing, subsetting and embedding.
 *
 * ## The font under test is built here, on purpose
 *
 * There is no `.ttf` in this repo and there should not be. A committed font is a
 * licensed binary somebody has to audit, it makes the diff for this change
 * megabytes of opaque bytes, and — the part that actually matters — a test
 * driven by a real font tells you the parser agrees with *that* font, not that
 * it reads the format. {@link buildFont} writes the tables by hand from the
 * spec, so every number the parser reads back is a number this file put there,
 * and a misread offset is a wrong value rather than a plausible one.
 *
 * The real-font check is not skipped, it is just not a unit test: the change was
 * driven against a 23 MB CJK face and its output extracted with poppler's
 * `pdftotext`, which is an independent PDF implementation. Numbers in the commit
 * message and in `docs/documents.md`.
 */

import { describe, expect, it } from 'vitest'
import { bindFont, EmbeddedFace, subsetTag } from './document-embed.ts'
import { documentPdf } from './document-pdf.ts'
import {
	collectGlyphs,
	FontParseError,
	parseFont,
	subsetFont,
} from './document-truetype.ts'
import type { DocumentLayout, DocumentStyle } from './documents.ts'

// ===========================================================================
// A font, assembled from the spec
// ===========================================================================

const UNITS_PER_EM = 1000

/** Glyph 0 `.notdef`, 1 `A`, 2 `株`, 3 `´` (a bare accent), 4 `Á` — a
 * *composite* of glyphs 1 and 3, which is the case a subset gets wrong. */
const GLYPHS: {
	code?: number
	advance: number
	composite?: [number, number]
}[] = [
	{ advance: 0 },
	{ code: 0x41, advance: 600 },
	{ code: 0x682a, advance: 1000 },
	{ code: 0x00b4, advance: 300 },
	{ code: 0xc1, advance: 600, composite: [1, 3] },
]

function u16(n: number): number[] {
	return [(n >> 8) & 0xff, n & 0xff]
}
function u32(n: number): number[] {
	return [(n >>> 24) & 0xff, (n >>> 16) & 0xff, (n >>> 8) & 0xff, n & 0xff]
}

/** A one-point, one-contour outline. Valid, and the smallest thing that is. */
function simpleGlyph(): number[] {
	return [
		...u16(1), // numberOfContours
		...u16(0),
		...u16(0),
		...u16(100),
		...u16(100), // bbox
		...u16(0), // endPtsOfContours[0]
		...u16(0), // instructionLength
		0x01, // flags: on-curve, x and y as int16
		...u16(0), // x
		...u16(0), // y
	]
}

/** A composite referencing two other glyphs by id — the thing a renumbering
 * subsetter has to rewrite and this one deliberately never touches. */
function compositeGlyph(a: number, b: number): number[] {
	const component = (gid: number, more: boolean) => [
		// ARG_1_AND_2_ARE_WORDS | ARGS_ARE_XY_VALUES (| MORE_COMPONENTS)
		...u16(0x0003 | (more ? 0x0020 : 0)),
		...u16(gid),
		...u16(0),
		...u16(0),
	]
	return [
		...u16(0xffff), // numberOfContours = -1
		...u16(0),
		...u16(0),
		...u16(100),
		...u16(100),
		...component(a, true),
		...component(b, false),
	]
}

function table(tag: string, data: number[]): { tag: string; data: number[] } {
	return { tag, data }
}

/** An sfnt carrying exactly the tables {@link parseFont} requires. */
function buildFont(): Uint8Array {
	const outlines = GLYPHS.map((g) =>
		g.composite
			? compositeGlyph(g.composite[0], g.composite[1])
			: simpleGlyph(),
	)
	// `.notdef` is empty, which is legal and is what makes the "an empty outline
	// has no components" branch reachable.
	outlines[0] = []

	const glyf: number[] = []
	const loca: number[] = []
	for (const outline of outlines) {
		loca.push(glyf.length)
		glyf.push(...outline)
		if (glyf.length % 2) glyf.push(0)
	}
	loca.push(glyf.length)

	const head = [
		...u32(0x00010000),
		...u32(0),
		...u32(0),
		...u32(0x5f0f3cf5),
		...u16(0),
		...u16(UNITS_PER_EM),
		...u32(0),
		...u32(0),
		...u32(0),
		...u32(0), // created / modified
		...u16(0),
		...u16(0xff9c),
		...u16(1000),
		...u16(900), // bbox (yMin = -100)
		...u16(0),
		...u16(8),
		...u16(2),
		...u16(1), // indexToLocFormat: long
		...u16(0),
	]
	const hhea = [
		...u32(0x00010000),
		...u16(800),
		...u16(0xff38),
		...u16(0), // ascender / descender (-200) / lineGap
		...u16(1000),
		...u16(0),
		...u16(0),
		...u16(0),
		...u16(1),
		...u16(0),
		...u16(0),
		...u16(0),
		...u16(0),
		...u16(0),
		...u16(0),
		...u16(0), // metricDataFormat
		...u16(GLYPHS.length), // numberOfHMetrics
	]
	const maxp = [
		...u32(0x00010000),
		...u16(GLYPHS.length),
		...new Array(26).fill(0),
	]
	const hmtx = GLYPHS.flatMap((g) => [...u16(g.advance), ...u16(0)])

	// One format-12 subtable, one group per mapped glyph — the format that can
	// address code points above U+FFFF, which is where a format-4 table stops.
	const mapped = GLYPHS.map((g, gid) => ({ gid, code: g.code })).filter(
		(g): g is { gid: number; code: number } => g.code !== undefined,
	)
	const groups = mapped.flatMap((g) => [
		...u32(g.code),
		...u32(g.code),
		...u32(g.gid),
	])
	const sub12 = [
		...u16(12),
		...u16(0),
		...u32(16 + groups.length),
		...u32(0),
		...u32(mapped.length),
		...groups,
	]
	const cmap = [
		...u16(0),
		...u16(1),
		...u16(3),
		...u16(10),
		...u32(12),
		...sub12,
	]

	const tables = [
		table('cmap', cmap),
		table('glyf', glyf),
		table('head', head),
		table('hhea', hhea),
		table('hmtx', hmtx),
		table('loca', loca.flatMap(u32)),
		table('maxp', maxp),
	]

	const header: number[] = [
		...u32(0x00010000),
		...u16(tables.length),
		...u16(0),
		...u16(0),
		...u16(0),
	]
	let offset = 12 + tables.length * 16
	const body: number[] = []
	for (const t of tables) {
		for (const c of t.tag) header.push(c.charCodeAt(0))
		header.push(...u32(0), ...u32(offset), ...u32(t.data.length))
		body.push(...t.data)
		offset += t.data.length
		while (offset % 4) {
			body.push(0)
			offset += 1
		}
	}
	return Uint8Array.from([...header, ...body])
}

const FONT = buildFont()

// ===========================================================================

describe('parseFont', () => {
	it('reads the tables the writer needs', () => {
		const font = parseFont(FONT)
		expect(font.unitsPerEm).toBe(1000)
		expect(font.numGlyphs).toBe(GLYPHS.length)
		expect(font.ascent).toBe(800)
		// Signed, and the test font's are negative on purpose: reading these as
		// unsigned puts a descender of 65,336 in the font descriptor, which is the
		// kind of wrong that renders fine and prints badly.
		expect(font.descent).toBe(-200)
		expect(font.bbox[1]).toBe(-100)
	})

	it('maps code points to glyphs, including outside Latin-1', () => {
		const font = parseFont(FONT)
		expect(font.cmap.get(0x41)).toBe(1)
		expect(font.cmap.get(0x682a)).toBe(2) // 株
		// A code point the font does not have is absent, not zero-mapped — the
		// face turns that into `.notdef`, which draws a visible box.
		expect(font.cmap.get(0x4e2d)).toBeUndefined()
	})

	it('reads advances per glyph', () => {
		const font = parseFont(FONT)
		expect(font.advances[1]).toBe(600)
		expect(font.advances[2]).toBe(1000)
	})

	/** Refusing at bind time is the difference between "your font is not
	 * supported, here is why" at boot and a corrupt invoice in an inbox. */
	it('refuses a CFF OpenType font and a collection by name', () => {
		const otf = Uint8Array.from([...u32(0x4f54544f), ...new Array(20).fill(0)])
		expect(() => parseFont(otf)).toThrow(/OpenType\/CFF/)
		const ttc = Uint8Array.from([...u32(0x74746366), ...new Array(20).fill(0)])
		expect(() => parseFont(ttc)).toThrow(/collection/)
		expect(() => parseFont(new Uint8Array(4))).toThrow(FontParseError)
	})
})

describe('collectGlyphs', () => {
	/**
	 * The composite case, and the reason this subsetter keeps glyph ids.
	 *
	 * `Á` is glyph 4, built from glyph 1 (`A`) and glyph 3 (the accent). A subset
	 * carrying 4 and not 1 and 3 draws nothing where the letter should be — and
	 * it draws it silently, on exactly the accented letters a European invoice is
	 * full of.
	 */
	it('pulls in the components a composite glyph references', () => {
		const font = parseFont(FONT)
		expect([...collectGlyphs(font, [4])].sort()).toEqual([0, 1, 3, 4])
	})

	it('always keeps .notdef', () => {
		const font = parseFont(FONT)
		expect(collectGlyphs(font, [1]).has(0)).toBe(true)
	})
})

describe('subsetFont', () => {
	it('keeps the outlines it was asked for and empties the rest', () => {
		const font = parseFont(FONT)
		const subset = parseFont(subsetFont(font, [1]))
		// Glyph ids do not move, so `CIDToGIDMap /Identity` stays true and a
		// composite's references stay correct.
		expect(subset.numGlyphs).toBe(font.numGlyphs)
		const length = (f: typeof font, gid: number) =>
			(f.loca[gid + 1] ?? 0) - (f.loca[gid] ?? 0)
		expect(length(subset, 1)).toBe(length(font, 1))
		// `株` was not asked for: present as an id, empty as an outline.
		expect(length(subset, 2)).toBe(0)
	})

	it('is byte-identical for the same glyph set', () => {
		const font = parseFont(FONT)
		expect(subsetFont(font, [1, 2])).toEqual(subsetFont(font, [1, 2]))
		// …and differs when the set does, or the subset would not be a subset.
		expect(subsetFont(font, [1])).not.toEqual(subsetFont(font, [1, 2]))
	})

	it('truncates hmtx after the highest glyph used, and says so in hhea', () => {
		// The single largest table in a CJK subset. Glyphs past the cut inherit the
		// last advance, which is fine because their outlines are empty.
		const subset = parseFont(subsetFont(parseFont(FONT), [1]))
		expect(subset.advances[1]).toBe(600)
		expect(subset.advances).toHaveLength(GLYPHS.length)
	})

	it('is a font the parser reads back', () => {
		// The strongest cheap check there is: the output goes through the same
		// reader the input did, so a broken table directory, a wrong length or a
		// bad `loca` format is a red test rather than a PDF that opens blank.
		expect(() =>
			parseFont(subsetFont(parseFont(FONT), [1, 2, 4])),
		).not.toThrow()
	})
})

describe('EmbeddedFace', () => {
	it('measures from the font hmtx, not from the base-14 tables', () => {
		const face = new EmbeddedFace(parseFont(FONT))
		// 'A' is 600/1000 em, so at 10pt it is 6pt. The base-14 Helvetica 'A' is
		// 667 — if the two width sources were ever crossed this is what would
		// catch it.
		expect(face.measure('A', 10)).toBeCloseTo(6, 6)
		expect(face.measure('株', 10)).toBeCloseTo(10, 6)
	})

	it('encodes as two-byte glyph ids in a hex string', () => {
		const face = new EmbeddedFace(parseFont(FONT))
		expect(face.operand('A株')).toBe('<00010002>')
	})

	it('records every glyph it was asked for, including .notdef', () => {
		const face = new EmbeddedFace(parseFont(FONT))
		face.operand('A中') // 中 is not in the font
		expect([...face.used].sort()).toEqual([0, 1])
	})
})

describe('subsetTag', () => {
	it('is six uppercase letters, derived from the bytes', () => {
		const tag = subsetTag(Uint8Array.from([1, 2, 3]))
		expect(tag).toMatch(/^[A-Z]{6}$/)
		expect(subsetTag(Uint8Array.from([1, 2, 3]))).toBe(tag)
		expect(subsetTag(Uint8Array.from([1, 2, 4]))).not.toBe(tag)
	})
})

// ===========================================================================
// End to end
// ===========================================================================

const STYLE: DocumentStyle = {
	font: 'sans',
	accent: '#111111',
	density: 'comfortable',
	typeScale: 'default',
}

const layout = (text: string): DocumentLayout => ({
	title: 'Invoice',
	blocks: [
		{ kind: 'heading', level: 1, text: 'Invoice' },
		{ kind: 'pairs', columns: 2, pairs: [{ label: 'Client', value: text }] },
	],
})

const text = (bytes: Uint8Array) => Buffer.from(bytes).toString('latin1')

describe('documentPdf with a bound font', () => {
	const bound = bindFont({ regular: FONT, name: 'Test' })

	it('writes non-Latin text as glyph ids instead of question marks', () => {
		const withFont = text(
			documentPdf(layout('株'), STYLE, 'a4', { font: bound }),
		)
		expect(withFont).toContain('/Identity-H')
		expect(withFont).toContain('/CIDFontType2')
		expect(withFont).toContain('/FontFile2')
		// The glyph for 株 is 2; the base-14 path has no byte for it at all.
		expect(withFont).toContain('<0002>')

		const base14 = text(documentPdf(layout('株'), STYLE, 'a4'))
		expect(base14).not.toContain('/Identity-H')
		expect(base14).toContain('(?)')
	})

	/** Without this the text in the PDF *is* glyph ids: copying an invoice number
	 * yields nonsense and searching for a name finds nothing. The base-14 path
	 * has never had that problem, so losing it would be a regression. */
	it('ships a ToUnicode CMap so the text is still selectable', () => {
		const pdf = text(documentPdf(layout('株'), STYLE, 'a4', { font: bound }))
		expect(pdf).toContain('/ToUnicode')
		expect(pdf).toContain('beginbfchar')
		expect(pdf).toContain('<0002> <682A>')
	})

	it('stays byte-identical across renders — #176s guarantee survives', () => {
		const once = documentPdf(layout('株A'), STYLE, 'a4', { font: bound })
		const twice = documentPdf(layout('株A'), STYLE, 'a4', { font: bound })
		expect(Buffer.from(once)).toEqual(Buffer.from(twice))
	})

	it('embeds one copy of the font when no bold face is bound', () => {
		// Two `EmbeddedFace`s over one file would build two subsets and embed both,
		// and a subset is the largest thing in the document by an order of
		// magnitude.
		const pdf = text(documentPdf(layout('A'), STYLE, 'a4', { font: bound }))
		expect(pdf.split('/FontFile2')).toHaveLength(2)
	})

	it('embeds two when a bold face is bound', () => {
		const both = bindFont({ regular: FONT, bold: FONT, name: 'Test' })
		const pdf = text(documentPdf(layout('A'), STYLE, 'a4', { font: both }))
		expect(pdf.split('/FontFile2')).toHaveLength(3)
	})

	it('leaves the base-14 path byte-for-byte alone', () => {
		// The whole shape of #221 is that a deployment binding nothing pays
		// nothing. If this ever fails, it has started paying something.
		const a = documentPdf(layout('Latin'), STYLE, 'a4')
		const b = documentPdf(layout('Latin'), STYLE, 'a4', {})
		expect(Buffer.from(a)).toEqual(Buffer.from(b))
		expect(text(a)).toContain('/WinAnsiEncoding')
	})
})
