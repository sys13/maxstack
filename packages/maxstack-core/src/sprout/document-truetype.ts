/**
 * TrueType parsing and subsetting for the PDF backend.
 *
 * ## What this is for
 *
 * Issue #176's PDF writer uses the **base-14** fonts — the fourteen every
 * conforming reader must have — which is what makes its image delta +81 KiB and
 * zero new dependencies rather than +150–300 MB of headless browser. The base-14
 * are WinAnsi-encoded and hold 224 glyphs, so anything outside Latin-1 has no
 * byte to be written as and prints `?`. Greek, Cyrillic, CJK, Devanagari,
 * Hebrew, Arabic, Thai: all of it.
 *
 * This module is the other half. A deployment **binds a font file** and gets its
 * own script; a deployment that binds nothing pays exactly nothing, and the
 * base-14 path is untouched. That is the shape issue #221 argues for, and the
 * reason is the one #176's decision was about: the image cost should be paid by
 * the deployments that need it, not by every deployment for coverage most of
 * them do not use.
 *
 * ## No dependency, and why that is not stubbornness
 *
 * A font library would be a 200–500 KB dependency in the runtime image plus its
 * transitive tree, to do something a PDF needs about 400 lines of table
 * arithmetic for. The whole document feature exists because "just add a
 * dependency" was the wrong answer once already (the browser). It is also the
 * only way to guarantee the determinism the feature promises: a third-party
 * subsetter is free to change its glyph ordering in a patch release, and the
 * byte-identical guarantee would break under `npm update` with nothing red.
 *
 * ## Subsetting: keep the glyph ids, drop the outlines
 *
 * The obvious subset renumbers glyphs densely and rewrites every reference. This
 * one does not: it keeps every glyph id where it was and emits an **empty
 * outline** for the ones nothing draws. Three things fall out, and they are why:
 *
 *  - `CIDToGIDMap` is `/Identity` — no map to build and none to get wrong.
 *  - **Composite glyphs keep working.** An accented letter is a composite that
 *    references its base and its accent *by glyph id*; a renumbering subset has
 *    to chase those references and rewrite them inside the outline data, and
 *    getting it wrong produces a glyph made of the wrong pieces. Here they are
 *    still correct because nothing moved — the referenced glyphs are simply also
 *    kept, which {@link collectGlyphs} does.
 *  - The output is deterministic without any ordering decision at all, because
 *    there is no ordering.
 *
 * The cost is `loca` and `hmtx`, which stay full length: 4 and 4 bytes per glyph
 * in the *original* font, so a 30,000-glyph CJK face carries ~240 KiB of tables
 * however few glyphs a document draws. Measured and stated in `docs/documents.md`
 * rather than discovered. Against a renumbering subsetter that is a few hundred
 * KiB per document; against embedding the whole face it is tens of megabytes
 * saved, and against getting a composite-glyph rewrite subtly wrong it is worth
 * paying outright.
 */

// ===========================================================================
// Reading
// ===========================================================================

/** A big-endian cursor over the font's bytes. Every offset in an sfnt is
 * absolute from the start of the file, so one view over the whole thing is the
 * honest shape — a per-table slice would have to re-add the offset everywhere. */
class Reader {
	private readonly view: DataView
	readonly bytes: Uint8Array

	constructor(bytes: Uint8Array) {
		this.bytes = bytes
		this.view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
	}

	u8(at: number): number {
		return this.view.getUint8(at)
	}
	u16(at: number): number {
		return this.view.getUint16(at)
	}
	i16(at: number): number {
		return this.view.getInt16(at)
	}
	u32(at: number): number {
		return this.view.getUint32(at)
	}
	tag(at: number): string {
		return String.fromCharCode(
			this.u8(at),
			this.u8(at + 1),
			this.u8(at + 2),
			this.u8(at + 3),
		)
	}
}

/** One table's location in the source font. */
interface TableEntry {
	offset: number
	length: number
}

/**
 * A font this module knows enough about to embed and subset.
 *
 * Deliberately not "a font" in any general sense: there is no name table, no
 * kerning, no OpenType feature. A PDF needs to place glyphs at advances and say
 * how wide they are, and everything here serves exactly that.
 */
export interface ParsedFont {
	/** The original bytes, kept because subsetting copies most tables verbatim. */
	readonly source: Uint8Array
	readonly tables: ReadonlyMap<string, TableEntry>
	readonly unitsPerEm: number
	readonly numGlyphs: number
	/** `0` = short `loca` (uint16, halved), `1` = long (uint32). */
	readonly indexToLocFormat: 0 | 1
	/** Glyph outline offsets into `glyf`, `numGlyphs + 1` entries. */
	readonly loca: readonly number[]
	/** Advance width per glyph, in font units. */
	readonly advances: readonly number[]
	/** Unicode code point → glyph id. */
	readonly cmap: ReadonlyMap<number, number>
	readonly bbox: readonly [number, number, number, number]
	readonly ascent: number
	readonly descent: number
	readonly italicAngle: number
	readonly capHeight: number
	/** Whether the face is monospaced, per `post.isFixedPitch`. PDF's descriptor
	 * flags carry it, and a reader substituting a fallback uses it. */
	readonly fixedPitch: boolean
}

export class FontParseError extends Error {
	constructor(reason: string) {
		super(`not a usable TrueType font: ${reason}`)
		this.name = 'FontParseError'
	}
}

/**
 * Parse the tables this module needs, and refuse anything it cannot embed
 * correctly.
 *
 * The refusals are the interesting part. A `CFF ` (OpenType/PostScript) face has
 * no `glyf` table at all — its outlines are in a compact format this does not
 * read — and embedding one as a `CIDFontType2` would produce a PDF whose glyphs
 * are garbage in some readers and absent in others. Refusing by name at bind
 * time is the difference between "your font is not supported, here is why" at
 * boot and a corrupt invoice in a customer's inbox.
 */
export function parseFont(source: Uint8Array): ParsedFont {
	const r = new Reader(source)
	if (source.length < 12) throw new FontParseError('file is too short')
	const version = r.u32(0)
	// `true` (0x74727565) is the old Apple TrueType tag; 0x00010000 is the
	// standard one; `ttcf` is a collection, which names no single face.
	if (version === 0x74746366)
		throw new FontParseError(
			'this is a TrueType *collection* (.ttc), which contains several faces and names none — extract the face you want first',
		)
	if (version === 0x4f54544f)
		throw new FontParseError(
			'this is an OpenType/CFF font (.otf with PostScript outlines). Its outlines are in a format this writer does not read; bind a TrueType-outline font (.ttf) instead',
		)
	if (version !== 0x00010000 && version !== 0x74727565)
		throw new FontParseError(
			`unrecognized sfnt version 0x${version.toString(16)}`,
		)

	const numTables = r.u16(4)
	const tables = new Map<string, TableEntry>()
	for (let i = 0; i < numTables; i++) {
		const at = 12 + i * 16
		if (at + 16 > source.length)
			throw new FontParseError('truncated table directory')
		tables.set(r.tag(at), { offset: r.u32(at + 8), length: r.u32(at + 12) })
	}

	const need = (tag: string): TableEntry => {
		const entry = tables.get(tag)
		if (!entry) throw new FontParseError(`missing the required "${tag}" table`)
		return entry
	}
	const head = need('head')
	const maxp = need('maxp')
	const hhea = need('hhea')
	const hmtx = need('hmtx')
	const locaEntry = need('loca')
	need('glyf')

	const unitsPerEm = r.u16(head.offset + 18)
	if (unitsPerEm === 0) throw new FontParseError('head.unitsPerEm is zero')
	const indexToLocFormat = r.i16(head.offset + 50)
	if (indexToLocFormat !== 0 && indexToLocFormat !== 1)
		throw new FontParseError(`head.indexToLocFormat is ${indexToLocFormat}`)
	const numGlyphs = r.u16(maxp.offset + 4)

	const loca: number[] = []
	for (let i = 0; i <= numGlyphs; i++) {
		loca.push(
			indexToLocFormat === 0
				? r.u16(locaEntry.offset + i * 2) * 2
				: r.u32(locaEntry.offset + i * 4),
		)
	}

	// `hmtx` is `numberOfHMetrics` pairs followed by left-side-bearings only;
	// every glyph past that count inherits the last advance, which is how a
	// monospaced font stores one width for thousands of glyphs.
	const numberOfHMetrics = r.u16(hhea.offset + 34)
	if (numberOfHMetrics === 0)
		throw new FontParseError('hhea.numberOfHMetrics is zero')
	const advances: number[] = []
	let last = 0
	for (let gid = 0; gid < numGlyphs; gid++) {
		if (gid < numberOfHMetrics) last = r.u16(hmtx.offset + gid * 4)
		advances.push(last)
	}

	const post = tables.get('post')
	const os2 = tables.get('OS/2')
	return {
		source,
		tables,
		unitsPerEm,
		numGlyphs,
		indexToLocFormat,
		loca,
		advances,
		cmap: readCmap(r, tables.get('cmap')),
		bbox: [
			r.i16(head.offset + 36),
			r.i16(head.offset + 38),
			r.i16(head.offset + 40),
			r.i16(head.offset + 42),
		],
		ascent: r.i16(hhea.offset + 4),
		descent: r.i16(hhea.offset + 6),
		// `post.italicAngle` is a 16.16 fixed-point value; the whole part is what a
		// PDF descriptor wants and the fraction never matters for substitution.
		italicAngle: post ? r.i16(post.offset + 4) : 0,
		// `OS/2` version 2 added `sCapHeight`. Below that there is nothing to read,
		// and 70% of the ascent is the conventional stand-in — used only when a
		// reader substitutes a missing font, which cannot happen for an embedded one.
		capHeight:
			os2 && r.u16(os2.offset) >= 2
				? r.i16(os2.offset + 88)
				: Math.round(r.i16(hhea.offset + 4) * 0.7),
		fixedPitch: post ? r.u32(post.offset + 12) !== 0 : false,
	}
}

/**
 * Unicode code point → glyph id, from the best `cmap` subtable available.
 *
 * Format 4 (BMP) and format 12 (full range) are the two that matter, and 12 is
 * preferred when present because format 4 cannot address anything above U+FFFF —
 * which is where emoji and the CJK extension blocks live. A font with neither is
 * not refused: it parses to an empty map, and every code point resolves to glyph
 * 0 (`.notdef`), which is a visible box rather than a wrong glyph.
 */
function readCmap(
	r: Reader,
	entry: TableEntry | undefined,
): Map<number, number> {
	const out = new Map<number, number>()
	if (!entry) return out
	const numSubtables = r.u16(entry.offset + 2)
	let best: { offset: number; format: number } | undefined
	for (let i = 0; i < numSubtables; i++) {
		const at = entry.offset + 4 + i * 8
		const platform = r.u16(at)
		const encoding = r.u16(at + 2)
		const offset = entry.offset + r.u32(at + 4)
		const format = r.u16(offset)
		// Unicode (0, any) or Windows Unicode BMP/full (3,1) and (3,10).
		const unicode =
			platform === 0 || (platform === 3 && (encoding === 1 || encoding === 10))
		if (!unicode) continue
		if (format !== 4 && format !== 12) continue
		if (!best || (format === 12 && best.format !== 12))
			best = { offset, format }
	}
	if (!best) return out

	if (best.format === 12) {
		const nGroups = r.u32(best.offset + 12)
		for (let i = 0; i < nGroups; i++) {
			const at = best.offset + 16 + i * 12
			const start = r.u32(at)
			const end = r.u32(at + 4)
			const startGid = r.u32(at + 8)
			// A pathological group would otherwise materialize millions of entries.
			// The cap is far above any real font's coverage and below anything that
			// would exhaust memory on a corrupt file.
			if (end - start > 0x20000) continue
			for (let c = start; c <= end; c++) out.set(c, startGid + (c - start))
		}
		return out
	}

	const segCount = r.u16(best.offset + 6) / 2
	const endAt = best.offset + 14
	const startAt = endAt + segCount * 2 + 2
	const deltaAt = startAt + segCount * 2
	const rangeAt = deltaAt + segCount * 2
	for (let s = 0; s < segCount; s++) {
		const end = r.u16(endAt + s * 2)
		const start = r.u16(startAt + s * 2)
		if (start > end) continue
		const delta = r.u16(deltaAt + s * 2)
		const rangeOffset = r.u16(rangeAt + s * 2)
		for (let c = start; c <= end && c !== 0xffff + 1; c++) {
			let gid: number
			if (rangeOffset === 0) gid = (c + delta) & 0xffff
			else {
				const at = rangeAt + s * 2 + rangeOffset + (c - start) * 2
				gid = r.u16(at)
				if (gid !== 0) gid = (gid + delta) & 0xffff
			}
			if (gid !== 0) out.set(c, gid)
		}
	}
	return out
}

// ===========================================================================
// Subsetting
// ===========================================================================

/** The tables a subset carries. Everything else — `name`, `post` names, `GSUB`,
 * hinting programs — is dropped: a PDF places glyphs at advances it computes
 * itself, so none of it is read, and shipping it would be shipping bytes nothing
 * looks at. `cmap` is dropped too, because Identity-H addresses glyphs by id. */
const SUBSET_TABLES = ['head', 'hhea', 'maxp', 'hmtx', 'loca', 'glyf'] as const

/**
 * Every glyph the given ones depend on, including composite components.
 *
 * A composite glyph — most accented letters, and a great many CJK glyphs — is a
 * list of *references to other glyphs* plus placements. Emitting the composite
 * without its components produces a glyph that draws nothing, or in some readers
 * draws whatever happens to be at those ids. Transitive, with a visited set,
 * because a component may itself be a composite.
 */
export function collectGlyphs(
	font: ParsedFont,
	wanted: Iterable<number>,
): Set<number> {
	const glyf = font.tables.get('glyf')
	// `.notdef` is always kept: it is what a reader draws for a code point the
	// document asks for and the font does not have, and an empty one is an
	// invisible failure.
	const keep = new Set<number>([0])
	if (!glyf) return keep
	const r = new Reader(font.source)
	const queue = [...wanted]
	while (queue.length > 0) {
		const gid = queue.pop() as number
		if (gid < 0 || gid >= font.numGlyphs || keep.has(gid)) continue
		keep.add(gid)
		const start = font.loca[gid] ?? 0
		const end = font.loca[gid + 1] ?? 0
		if (end <= start) continue // an empty outline (a space) has no components
		const at = glyf.offset + start
		if (r.i16(at) >= 0) continue // simple glyph
		// Composite: a flag/index pair per component, walked until the
		// MORE_COMPONENTS bit clears.
		let cursor = at + 10
		for (;;) {
			const flags = r.u16(cursor)
			queue.push(r.u16(cursor + 2))
			cursor += 4
			cursor += flags & 0x0001 ? 4 : 2 // ARG_1_AND_2_ARE_WORDS
			if (flags & 0x0008)
				cursor += 2 // WE_HAVE_A_SCALE
			else if (flags & 0x0040)
				cursor += 4 // X_AND_Y_SCALE
			else if (flags & 0x0080) cursor += 8 // TWO_BY_TWO
			if (!(flags & 0x0020)) break // MORE_COMPONENTS
		}
	}
	return keep
}

function pad4(n: number): number {
	return (4 - (n % 4)) % 4
}

/** The sfnt table checksum: the sum of the table's bytes read as big-endian
 * uint32s, with the tail zero-padded, modulo 2^32. */
function checksum(bytes: Uint8Array): number {
	let sum = 0
	for (let i = 0; i < bytes.length; i += 4) {
		const word =
			((bytes[i] ?? 0) << 24) |
			((bytes[i + 1] ?? 0) << 16) |
			((bytes[i + 2] ?? 0) << 8) |
			(bytes[i + 3] ?? 0)
		sum = (sum + word) >>> 0
	}
	return sum >>> 0
}

/**
 * A font file carrying outlines for `wanted` (and their components) and empty
 * outlines for everything else.
 *
 * **Byte-identical for the same font and the same glyph set**, which is the
 * property #176's determinism guarantee needs and the reason the glyph set is
 * consumed as a *sorted* list rather than in iteration order: a `Set` iterates
 * in insertion order, so the same document rendered from rows fetched in a
 * different order would otherwise subset to different bytes.
 */
export function subsetFont(
	font: ParsedFont,
	wanted: Iterable<number>,
): Uint8Array {
	const keep = collectGlyphs(font, wanted)
	const glyf = font.tables.get('glyf')
	if (!glyf) throw new FontParseError('missing the required "glyf" table')
	const source = font.source

	// New `glyf` + `loca`, glyph ids unchanged. A dropped glyph contributes a
	// zero-length entry, which is a legal empty outline.
	const glyfParts: Uint8Array[] = []
	const offsets: number[] = []
	let at = 0
	for (let gid = 0; gid < font.numGlyphs; gid++) {
		offsets.push(at)
		if (!keep.has(gid)) continue
		const start = font.loca[gid] ?? 0
		const end = font.loca[gid + 1] ?? 0
		if (end <= start) continue
		const outline = source.subarray(glyf.offset + start, glyf.offset + end)
		glyfParts.push(outline)
		at += outline.length
		// Every glyph offset must be even for the short `loca` format, and padding
		// an outline with zero bytes is harmless — the length is taken from the
		// *next* offset, and a reader stops at the contour count either way.
		const pad = at % 2
		if (pad) {
			glyfParts.push(new Uint8Array(1))
			at += 1
		}
	}
	offsets.push(at)

	const glyfBytes = concat(glyfParts)
	// Long `loca` unconditionally: the short format halves offsets and therefore
	// cannot address a `glyf` past 128 KiB, and choosing per-font would make the
	// output depend on how much of the font a document happened to use.
	const locaBytes = new Uint8Array((font.numGlyphs + 1) * 4)
	const locaView = new DataView(locaBytes.buffer)
	for (const [i, offset] of offsets.entries()) locaView.setUint32(i * 4, offset)

	const out = new Map<string, Uint8Array>()
	out.set('glyf', glyfBytes)
	out.set('loca', locaBytes)
	for (const tag of SUBSET_TABLES) {
		if (tag === 'glyf' || tag === 'loca') continue
		const entry = font.tables.get(tag)
		if (!entry) throw new FontParseError(`missing the required "${tag}" table`)
		out.set(tag, source.slice(entry.offset, entry.offset + entry.length))
	}

	// `hmtx` is truncated after the highest glyph the document uses, and `hhea`
	// is patched to say so.
	//
	// This is the one size optimization worth its risk. `hmtx` is four bytes per
	// glyph in the *original* face, so a 50,000-glyph CJK font carries 200 KiB of
	// advances however few glyphs an invoice draws — the single largest thing in
	// the subset after `loca`. The format already has the mechanism: glyphs at or
	// past `numberOfHMetrics` inherit the last entry's advance, which is how a
	// monospaced font stores one width for thousands of glyphs. Every glyph past
	// the cut has an empty outline here, so the advance it inherits is never
	// drawn.
	const highest = Math.max(...keep)
	const metrics = Math.min(highest + 1, font.numGlyphs)
	const hmtx = new Uint8Array(metrics * 4)
	const hmtxView = new DataView(hmtx.buffer)
	for (let gid = 0; gid < metrics; gid++)
		hmtxView.setUint16(gid * 4, font.advances[gid] ?? 0)
	out.set('hmtx', hmtx)
	const hhea = out.get('hhea') as Uint8Array
	new DataView(hhea.buffer, hhea.byteOffset, hhea.byteLength).setUint16(
		34,
		metrics,
	)

	// `head` has to say the `loca` format is long now, and its
	// `checkSumAdjustment` is zeroed: it is a checksum *of the whole file*, which
	// would have to be computed after assembly and then written back into a table
	// whose own checksum it changes. Zero is what every subsetter writes and what
	// every reader accepts; a PDF never validates it.
	const head = out.get('head') as Uint8Array
	const headView = new DataView(head.buffer, head.byteOffset, head.byteLength)
	headView.setUint32(8, 0)
	headView.setInt16(50, 1)

	const tags = [...out.keys()].sort()
	const numTables = tags.length
	// The binary-search hint fields. Readers ignore them in practice, but they
	// are computed rather than zeroed because a validator does not.
	let entrySelector = 0
	while (1 << (entrySelector + 1) <= numTables) entrySelector += 1
	const searchRange = (1 << entrySelector) * 16

	const header = new Uint8Array(12 + numTables * 16)
	const headerView = new DataView(header.buffer)
	headerView.setUint32(0, 0x00010000)
	headerView.setUint16(4, numTables)
	headerView.setUint16(6, searchRange)
	headerView.setUint16(8, entrySelector)
	headerView.setUint16(10, numTables * 16 - searchRange)

	const body: Uint8Array[] = []
	let offset = header.length
	tags.forEach((tag, i) => {
		const data = out.get(tag) as Uint8Array
		const recordAt = 12 + i * 16
		for (let c = 0; c < 4; c++)
			headerView.setUint8(recordAt + c, tag.charCodeAt(c))
		headerView.setUint32(recordAt + 4, checksum(data))
		headerView.setUint32(recordAt + 8, offset)
		headerView.setUint32(recordAt + 12, data.length)
		body.push(data)
		offset += data.length
		const pad = pad4(data.length)
		if (pad > 0) {
			body.push(new Uint8Array(pad))
			offset += pad
		}
	})

	return concat([header, ...body])
}

function concat(parts: readonly Uint8Array[]): Uint8Array {
	const total = parts.reduce((n, p) => n + p.length, 0)
	const out = new Uint8Array(total)
	let at = 0
	for (const part of parts) {
		out.set(part, at)
		at += part.length
	}
	return out
}
