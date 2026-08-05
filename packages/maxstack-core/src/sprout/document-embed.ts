/**
 * An embedded, subset font for the PDF backend — the half of
 * document rendering that can print a script the base-14 fonts cannot.
 *
 * ## The bound-font shape, and why not "always embed"
 *
 * Issue #221 weighs three options and this is the middle one: **the writer ships
 * with base-14 by default, and a deployment may bind a font file.** A deployment
 * that binds nothing pays exactly nothing — no font in the image, no new
 * dependency, and #176's measured `+81 KiB / zero dependencies` still holds. A
 * deployment whose customers are named in Japanese binds a font and pays for the
 * coverage it actually uses.
 *
 * "Always embed" is the simplest code and the worst default: every deployment
 * would carry tens of megabytes of CJK outlines for a product that prints Latin
 * invoices, which reopens the deploy-story question #176's decision was about.
 * "Do nothing" is where this started, and it is defensible for a Latin-script
 * product — but the HTML target covering the rest is a workaround, not an answer,
 * because a PDF is what people attach to emails.
 *
 * ## What changes in the PDF, and what does not
 *
 * A simple font addresses glyphs with one byte through an encoding table, which
 * is why the base-14 path tops out at 224 of them. An embedded font is a
 * **Type0 font with Identity-H encoding**: text is two-byte *glyph ids*, the
 * descendant is a `CIDFontType2` carrying the subset file, and `CIDToGIDMap` is
 * `/Identity` because {@link subsetFont} never renumbers a glyph.
 *
 * That changes every text-showing operator, which is exactly why
 * {@link DocumentFace} exists: the writer asks a face for an operand and never
 * learns which kind it has.
 *
 * A `ToUnicode` CMap ships with it, and is not optional in practice. Without one
 * the text in the PDF *is* glyph ids, so selecting an invoice total and copying
 * it yields nonsense and a search for a customer's name finds nothing — the
 * base-14 path has never had that problem, and losing it in exchange for correct
 * glyphs would be a trade nobody asked for.
 *
 * ## Determinism survives
 *
 * #176's guarantee is that re-rendering the same row produces the same bytes.
 * Two things here could break it and neither does: the glyph set is consumed
 * **sorted** rather than in the order the document happened to use them, and the
 * six-letter subset tag PDF requires is derived from the subset's own bytes
 * rather than from a counter or a clock. Asserted in `document-pdf.test.ts`
 * against a document rendered twice with its rows in different orders.
 */

import type { DocumentFace } from './document-fonts.ts'
import { type ParsedFont, parseFont, subsetFont } from './document-truetype.ts'

/**
 * The font files a deployment bound, as bytes.
 *
 * `bold` is optional, and its absence is a stated degradation rather than a
 * failure: bold text renders in the regular face. Synthesizing a bold — the
 * other option — is what readers do when a font is *missing*, and it looks like
 * a rendering bug rather than a choice. A deployment that cares binds both.
 */
export interface BoundFontFiles {
	regular: Uint8Array
	bold?: Uint8Array
	/** The `/BaseFont` name, before the subset tag. Letters, digits and hyphens;
	 * anything else is stripped, because it lands in a PDF name object. */
	name?: string
}

/** A bound font, parsed. Built once per deployment, not per document — parsing a
 * 20 MB CJK face on every invoice would be the slowest thing in the request. */
export interface BoundFont {
	regular: ParsedFont
	bold?: ParsedFont
	name: string
}

/** Parse bound font files, or throw a `FontParseError` naming what is wrong. */
export function bindFont(files: BoundFontFiles): BoundFont {
	const name =
		(files.name ?? 'BoundFont').replace(/[^A-Za-z0-9-]/g, '') || 'BoundFont'
	return {
		regular: parseFont(files.regular),
		...(files.bold ? { bold: parseFont(files.bold) } : {}),
		name,
	}
}

/**
 * A face over an embedded font, recording every glyph it is asked to draw.
 *
 * The recording is the reason this is stateful. A subset can only be built once
 * the whole document is laid out — you cannot know which glyphs an invoice needs
 * until you have wrapped its last line — so measuring and encoding *are* the
 * collection pass, and there is no second traversal to get out of step with the
 * first.
 */
export class EmbeddedFace implements DocumentFace {
	readonly font: ParsedFont
	/** Every glyph id this face was asked for, across the whole document. */
	readonly used = new Set<number>()

	constructor(font: ParsedFont) {
		this.font = font
	}

	/** The glyph for a code point, or `.notdef` (0) when the font has none.
	 * Recorded either way: a document that asks for a glyph the bound font lacks
	 * should print the reader's missing-glyph box, which is a visible "this font
	 * does not have that character" rather than a silent gap. */
	private gid(codePoint: number): number {
		const gid = this.font.cmap.get(codePoint) ?? 0
		this.used.add(gid)
		return gid
	}

	measure(text: string, sizePt: number): number {
		let units = 0
		for (const char of text)
			units += this.advance(this.gid(char.codePointAt(0) ?? 0))
		return (units * sizePt) / this.font.unitsPerEm
	}

	/** The glyph's advance, in the font's own units. Straight from `hmtx` — the
	 * base-14 path's transcribed AFM tables are not consulted for an embedded
	 * font, so the two width sources can never disagree about one string. */
	private advance(gid: number): number {
		return this.font.advances[gid] ?? 0
	}

	operand(text: string): string {
		let out = '<'
		for (const char of text) {
			const code = char.codePointAt(0) ?? 0
			// A newline inside a single drawn line would be a control character in
			// the glyph stream; the base-14 path maps it to a space and so does this.
			const gid = this.gid(code === 0x0a || code === 0x0d ? 0x20 : code)
			out += gid.toString(16).toUpperCase().padStart(4, '0')
		}
		return `${out}>`
	}

	/** Code point → glyph id for everything drawn, for the `ToUnicode` CMap. */
	toUnicode(): Map<number, number> {
		const out = new Map<number, number>()
		for (const [code, gid] of this.font.cmap)
			if (this.used.has(gid) && !out.has(gid)) out.set(gid, code)
		return out
	}
}

/**
 * A subset's six-letter tag, derived from its bytes.
 *
 * PDF requires a subset `/BaseFont` to be `ABCDEF+Name`, six uppercase letters,
 * so that two different subsets of the same face in one file are distinguishable.
 * Derived from the content rather than from a counter for the reason everything
 * else here is: a counter makes the same document render differently depending
 * on how many fonts came before it, and the guarantee is byte-identity.
 */
export function subsetTag(bytes: Uint8Array): string {
	// FNV-1a, 32-bit. Not a security hash — a collision between two subsets of
	// the same face in one document would produce two identically-named fonts,
	// which readers tolerate; it is here to be short, stable and dependency-free.
	let hash = 0x811c9dc5
	for (const byte of bytes) {
		hash ^= byte
		hash = Math.imul(hash, 0x01000193) >>> 0
	}
	let tag = ''
	for (let i = 0; i < 6; i++) {
		tag += String.fromCharCode(65 + (hash % 26))
		hash = Math.floor(hash / 26) + 7
	}
	return tag
}

/** One embedded font, as the PDF objects it needs. */
export interface EmbeddedFontObjects {
	/** The `/Type0` font dictionary a page's `/Resources` points at. */
	type0: string
	descendant: string
	descriptor: string
	/** `<< /Length … >> stream … endstream`, with the font as latin-1 chars. */
	fontFile: string
	toUnicode: string
}

/**
 * Build the five objects an embedded font needs.
 *
 * `ids` are the object numbers they will be written at — passed in rather than
 * allocated here because a PDF's cross-reference table is built in one pass over
 * a fixed numbering, and a font that allocated its own numbers would have to
 * negotiate with the page objects.
 */
export function embeddedFontObjects(
	face: EmbeddedFace,
	baseName: string,
	ids: {
		type0: number
		descendant: number
		descriptor: number
		fontFile: number
		toUnicode: number
	},
): EmbeddedFontObjects {
	const font = face.font
	// Sorted, so the subset is a function of the glyph *set* rather than of the
	// order the document happened to draw them in.
	const gids = [...face.used].sort((a, b) => a - b)
	const subset = subsetFont(font, gids)
	const name = `${subsetTag(subset)}+${baseName}`
	const scale = 1000 / font.unitsPerEm
	const round = (n: number) => Math.round(n * scale)

	// `/W` in the sparse `gid [w]` form. The dense `first last w` form is shorter
	// for a contiguous run and this deliberately does not use it: a document's
	// glyph ids are scattered across the face, so the runs would mostly be of
	// length one, and the branch would be code nothing exercises.
	const widths = gids
		.map((gid) => `${gid}[${round(font.advances[gid] ?? 0)}]`)
		.join(' ')

	const flags =
		// bit 1 FixedPitch · bit 3 Symbolic (set rather than Nonsymbolic, because a
		// font reached through Identity-H has no encoding a reader could call
		// standard) · bit 7 Italic.
		(font.fixedPitch ? 1 : 0) | 4 | (font.italicAngle !== 0 ? 64 : 0)

	const [xMin, yMin, xMax, yMax] = font.bbox
	return {
		type0:
			`<< /Type /Font /Subtype /Type0 /BaseFont /${name} /Encoding /Identity-H ` +
			`/DescendantFonts [${ids.descendant} 0 R] /ToUnicode ${ids.toUnicode} 0 R >>`,
		descendant:
			`<< /Type /Font /Subtype /CIDFontType2 /BaseFont /${name} ` +
			`/CIDSystemInfo << /Registry (Adobe) /Ordering (Identity) /Supplement 0 >> ` +
			`/FontDescriptor ${ids.descriptor} 0 R /DW 1000 /W [${widths}] ` +
			`/CIDToGIDMap /Identity >>`,
		descriptor:
			`<< /Type /FontDescriptor /FontName /${name} /Flags ${flags} ` +
			`/FontBBox [${round(xMin)} ${round(yMin)} ${round(xMax)} ${round(yMax)}] ` +
			`/ItalicAngle ${font.italicAngle} /Ascent ${round(font.ascent)} ` +
			`/Descent ${round(font.descent)} /CapHeight ${round(font.capHeight)} ` +
			// StemV is the vertical stem width, which a PDF descriptor requires and
			// nothing in a TrueType file records. 80 is the conventional stand-in and
			// is read only when a reader substitutes a font it does not have — which
			// cannot happen here, because the font is in the file.
			`/StemV 80 /FontFile2 ${ids.fontFile} 0 R >>`,
		fontFile: `<< /Length ${subset.length} /Length1 ${subset.length} >>\nstream\n${latin1(subset)}\nendstream`,
		toUnicode: toUnicodeCMap(face),
	}
}

/** Font bytes as a JS string of code units 0–255, which the writer turns back
 * into bytes with `& 0xff`. The PDF is assembled as text and emitted as bytes,
 * and this is the one place binary has to cross that seam. */
function latin1(bytes: Uint8Array): string {
	let out = ''
	// Chunked, because `String.fromCharCode(...huge)` blows the argument limit on
	// a multi-megabyte font.
	for (let i = 0; i < bytes.length; i += 4096)
		out += String.fromCharCode(...bytes.subarray(i, i + 4096))
	return out
}

/**
 * The `ToUnicode` CMap: glyph id → the code point it came from.
 *
 * This is what makes the text in an embedded-font PDF selectable, copyable and
 * searchable. Without it a reader has two-byte glyph ids and no idea what they
 * mean, so copying an invoice number yields mojibake — a regression against the
 * base-14 path, where the bytes *are* the characters.
 */
function toUnicodeCMap(face: EmbeddedFace): string {
	const pairs = [...face.toUnicode()].sort((a, b) => a[0] - b[0])
	// Uppercase: PDF hex strings conventionally are, and a CMap that mixes cases
	// between the glyph id and the code point reads as two different encodings.
	const hex = (n: number) => n.toString(16).toUpperCase().padStart(4, '0')
	// A code point above the BMP needs a surrogate pair in the CMap's UTF-16BE
	// destination string, which is what a reader reassembles when you copy.
	const dst = (code: number): string => {
		if (code <= 0xffff) return hex(code)
		const v = code - 0x10000
		return hex(0xd800 + (v >> 10)) + hex(0xdc00 + (v & 0x3ff))
	}
	// 100 is the format's per-block maximum, not a tuning choice.
	const blocks: string[] = []
	for (let i = 0; i < pairs.length; i += 100) {
		const chunk = pairs.slice(i, i + 100)
		blocks.push(
			`${chunk.length} beginbfchar\n${chunk
				.map(([gid, code]) => `<${hex(gid)}> <${dst(code)}>`)
				.join('\n')}\nendbfchar`,
		)
	}
	const body = [
		'/CIDInit /ProcSet findresource begin',
		'12 dict begin',
		'begincmap',
		'/CIDSystemInfo << /Registry (Adobe) /Ordering (UCS) /Supplement 0 >> def',
		'/CMapName /Adobe-Identity-UCS def',
		'/CMapType 2 def',
		'1 begincodespacerange',
		'<0000> <FFFF>',
		'endcodespacerange',
		...blocks,
		'endcmap',
		'CMapName currentdict /CMap defineresource pop',
		'end',
		'end',
	].join('\n')
	return `<< /Length ${body.length} >>\nstream\n${body}\nendstream`
}
