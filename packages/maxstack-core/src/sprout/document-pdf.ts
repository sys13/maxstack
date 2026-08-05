/**
 * The PDF backend for a compiled document layout — a dependency-free
 * PDF 1.4 writer.
 *
 * ## The recorded decision
 *
 * The issue's gate: *"PDF generation must not drag a browser into the runtime
 * image. A headless Chromium dependency would materially change the deploy story
 * and image size — if that is the chosen path it needs a recorded decision, not
 * a quiet `package.json` line."* It is not the chosen path. The full argument
 * lives in `docs/documents.md`; the short version is three properties a browser
 * cannot give:
 *
 * 1. **Zero image cost.** No browser, no font files, no npm dependency. The
 *    runtime tarball is the same size with this feature as without it, measured
 *    and recorded on issue #176.
 * 2. **Byte-identical output.** There is no `/CreationDate`, no `/ModDate` and
 *    no `/ID` in the file, and nothing in this module reads a clock or a random
 *    source. The same layout produces the same bytes, today and next year, on
 *    any machine. A Chromium render varies with the browser build even when the
 *    input does not — which means an archived copy could never be compared
 *    against a re-render.
 * 3. **No sandbox in the request path.** Rendering a document is a `read`; it
 *    should not require a process that can be told to fetch a URL.
 *
 * The price is stated rather than hidden: this writer lays out the six block
 * kinds the layout model has, and nothing else. It is not a CSS engine, and it
 * will never render an arbitrary page. That is the same bargain the section
 * vocabulary makes — see `documents.ts` in `@maxstack/spec`.
 *
 * ## The shape of the file
 *
 * A minimal, uncompressed PDF 1.4: catalog → pages → one content stream per
 * page, with the base-14 fonts referenced by name and never embedded. Streams
 * are uncompressed on purpose. Deflate would save perhaps 60% on a document
 * whose payload is a few kilobytes of text, and it would cost the two properties
 * that actually matter here — the bytes stop being a pure function of the input
 * (zlib levels and implementations differ), and the file stops being readable in
 * a text editor when somebody is trying to work out why a column is off.
 *
 * ## Coordinates
 *
 * PDF's origin is the *bottom* left and y grows upward, which is the opposite of
 * every other coordinate system in this codebase. The layout engine below works
 * in a top-down cursor and converts once, at the point of emission, rather than
 * asking every call site to remember.
 */

import type { BoundFont } from './document-embed.ts'
import { EmbeddedFace, embeddedFontObjects } from './document-embed.ts'
import {
	base14Face,
	type DocumentFace,
	type DocumentPdfFont,
	PDF_FONT_FAMILIES,
	truncateToWidth,
	wrapText,
} from './document-fonts.ts'
import { DOCUMENT_BASE_PT, DOCUMENT_LINE_HEIGHT } from './document-html.ts'
import type {
	DocumentBlock,
	DocumentLayout,
	DocumentPageSize,
	DocumentStyle,
} from './documents.ts'

// ===========================================================================
// Geometry
// ===========================================================================

/** Paper, in PostScript points (1/72"). The same two the HTML backend names. */
const PAGE_SIZES: Record<DocumentPageSize, { width: number; height: number }> =
	{
		// 210 × 297mm and 8.5 × 11in, converted once here.
		a4: { width: 595.28, height: 841.89 },
		letter: { width: 612, height: 792 },
	}

/** 18mm, matching the HTML backend's `@page` margin so the two agree on the text column. */
const MARGIN = 51

/** The accent as PDF's `r g b` operands, 0–1. */
function rgb(hex: string): [number, number, number] {
	const clean = hex.replace('#', '')
	const full =
		clean.length === 3
			? clean
					.split('')
					.map((c) => c + c)
					.join('')
			: clean
	const value = Number.parseInt(full, 16)
	if (!Number.isFinite(value)) return [0, 0, 0]
	return [
		((value >> 16) & 0xff) / 255,
		((value >> 8) & 0xff) / 255,
		(value & 0xff) / 255,
	]
}

/** Trim a float to 2dp for the content stream — fewer bytes, and stable text. */
const n2 = (n: number): string => (Math.round(n * 100) / 100).toString()

// ===========================================================================
// The content-stream builder
// ===========================================================================

/** Which of the two declared faces a run of text is set in. */
type Weight = 'regular' | 'bold'

interface Sizes {
	base: number
	h1: number
	h2: number
	small: number
	line: number
	gap: number
}

function sizesFor(style: DocumentStyle): Sizes {
	const base = DOCUMENT_BASE_PT[style.typeScale]
	return {
		base,
		h1: base * 1.8,
		h2: base * 1.25,
		small: base * 0.85,
		line: base * DOCUMENT_LINE_HEIGHT[style.density],
		gap: style.density === 'compact' ? 8 : 12,
	}
}

/**
 * A page under construction: the operator text, plus the cursor.
 *
 * The cursor is `y` measured **down from the top margin**, converted at
 * emission. See the module comment.
 */
class PageBuilder {
	readonly ops: string[] = []
	y = 0
}

/** The document title in the Info dictionary. Always a base-14 literal string,
 * even when a font is bound: the Info dictionary is metadata read by a file
 * browser, not text drawn on a page, so it has no font to be encoded against.
 * A non-Latin title therefore still shows `?` *in the file properties* while
 * printing correctly on the page — stated in `docs/documents.md` rather than
 * left as a surprise. */
function infoString(text: string): string {
	return base14Face('Helvetica').operand(text)
}

/**
 * The whole render, as a layout engine over the block list.
 *
 * One pass, top to bottom, with a page break taken whenever the next unit does
 * not fit. Units are chosen so that a break never lands somewhere embarrassing:
 * a table row is a unit (a line item is never split across pages), a header row
 * is re-emitted at the top of each continuation, and a heading will not be left
 * alone at the foot of a page.
 */
class DocumentWriter {
	private readonly pages: PageBuilder[] = []
	private page: PageBuilder
	private readonly sizes: Sizes
	private readonly fonts: { regular: DocumentPdfFont; bold: DocumentPdfFont }
	/**
	 * The two faces every draw goes through — base-14 when nothing
	 * is bound, embedded when something is.
	 *
	 * Held as faces rather than as a `bound ? … : …` at each call site, because
	 * an embedded face is also the *collector*: measuring and encoding record the
	 * glyphs the subset will need, so a text path that skipped the face would
	 * draw a glyph the embedded font does not carry.
	 */
	private readonly faces: { regular: DocumentFace; bold: DocumentFace }
	/** Present iff a font is bound. The assembler reads them for the subset. */
	readonly embedded?: { regular: EmbeddedFace; bold: EmbeddedFace }
	private readonly accent: [number, number, number]
	private readonly width: number
	private readonly height: number
	/** The usable text column. */
	private readonly column: number

	constructor(
		style: DocumentStyle,
		pageSize: DocumentPageSize,
		bound?: BoundFont,
	) {
		const paper = PAGE_SIZES[pageSize]
		this.width = paper.width
		this.height = paper.height
		this.column = paper.width - MARGIN * 2
		this.sizes = sizesFor(style)
		this.fonts = PDF_FONT_FAMILIES[style.font]
		if (bound) {
			// A deployment that bound only a regular face gets it for bold too. The
			// alternative — a synthesized bold — is what a reader does for a font it
			// does not have, and it reads as a rendering bug rather than a choice.
			// One face object when only a regular is bound, not two over the same
			// file: two would build two subsets of the same font and embed both,
			// and a subset is the largest thing in the document by an order of
			// magnitude.
			const regular = new EmbeddedFace(bound.regular)
			const bold = bound.bold ? new EmbeddedFace(bound.bold) : regular
			this.embedded = { regular, bold }
			this.faces = { regular, bold }
		} else {
			this.faces = {
				regular: base14Face(PDF_FONT_FAMILIES[style.font].regular),
				bold: base14Face(PDF_FONT_FAMILIES[style.font].bold),
			}
		}
		this.accent = rgb(style.accent)
		this.page = new PageBuilder()
		this.pages.push(this.page)
	}

	/** The bottom of the text column, as a top-down cursor value. */
	private get maxY(): number {
		return this.height - MARGIN * 2
	}

	private newPage(): void {
		this.page = new PageBuilder()
		this.pages.push(this.page)
	}

	/** Take a page break if `need` points do not remain. */
	private ensure(need: number): void {
		if (this.page.y + need > this.maxY && this.page.y > 0) this.newPage()
	}

	private fontName(weight: Weight): string {
		return weight === 'bold' ? '/F2' : '/F1'
	}

	private face(weight: Weight): DocumentFace {
		return weight === 'bold' ? this.faces.bold : this.faces.regular
	}

	/**
	 * Draw one line of text at the cursor, advancing it.
	 *
	 * `align: 'right'` measures rather than relying on a text operator, because
	 * PDF has no concept of alignment — a right-aligned number is a number drawn
	 * at `x = right - width`, and the width is the whole reason the font metrics
	 * exist.
	 */
	private line(
		text: string,
		opts: {
			size: number
			weight?: Weight
			color?: [number, number, number]
			x?: number
			width?: number
			align?: 'left' | 'right'
			advance?: number
		},
	): void {
		const weight = opts.weight ?? 'regular'
		const x0 = opts.x ?? MARGIN
		const boxWidth = opts.width ?? this.column
		const size = opts.size
		const drawX =
			opts.align === 'right'
				? x0 + boxWidth - this.face(weight).measure(text, size)
				: x0
		// The baseline sits one size below the cursor, so the cursor is always the
		// top of the line box — which is what makes `ensure()` arithmetic mean what
		// it says.
		const baseline = this.height - MARGIN - this.page.y - size
		const [r, g, b] = opts.color ?? [0.07, 0.07, 0.07]
		this.page.ops.push(
			`BT ${r} ${g} ${b} rg ${this.fontName(weight)} ${n2(size)} Tf 1 0 0 1 ${n2(drawX)} ${n2(baseline)} Tm ${this.face(weight).operand(text)} Tj ET`,
		)
		this.page.y += opts.advance ?? size * 1.35
	}

	/** A filled rectangle, used for rules. `y` is the cursor position of its top. */
	private rule(color: [number, number, number], thickness = 0.6): void {
		const top = this.height - MARGIN - this.page.y
		const [r, g, b] = color
		this.page.ops.push(
			`${r} ${g} ${b} rg ${n2(MARGIN)} ${n2(top - thickness)} ${n2(this.column)} ${n2(thickness)} re f`,
		)
		this.page.y += thickness
	}

	private paragraph(
		text: string,
		opts: {
			size: number
			weight?: Weight
			color?: [number, number, number]
			x?: number
			width?: number
		},
	): void {
		const lines = wrapText(
			text,
			this.face(opts.weight ?? 'regular'),
			opts.size,
			opts.width ?? this.column,
		)
		const advance = Math.max(opts.size * 1.35, this.sizes.line)
		for (const line of lines) {
			this.ensure(advance)
			this.line(line, { ...opts, advance })
		}
	}

	private caption(text: string): void {
		this.ensure(this.sizes.small * 1.6)
		this.line(text.toUpperCase(), {
			size: this.sizes.small,
			weight: 'bold',
			color: [0.35, 0.35, 0.35],
			advance: this.sizes.small * 1.8,
		})
	}

	write(layout: DocumentLayout): void {
		for (const block of layout.blocks) this.block(block)
	}

	private block(block: DocumentBlock): void {
		switch (block.kind) {
			case 'heading': {
				const size = block.level === 1 ? this.sizes.h1 : this.sizes.h2
				// A heading needs its own height plus a line of whatever follows it, or
				// it ends up orphaned at the foot of a page.
				this.ensure(size * 1.4 + this.sizes.line)
				if (block.level === 2) this.page.y += this.sizes.gap
				this.paragraph(block.text, {
					size,
					weight: 'bold',
					color: block.level === 1 ? this.accent : [0.07, 0.07, 0.07],
				})
				this.page.y += this.sizes.gap / 2
				break
			}
			case 'paragraph':
				this.paragraph(block.text, { size: this.sizes.base })
				this.page.y += this.sizes.gap / 2
				break
			case 'rule':
				this.ensure(this.sizes.gap * 2)
				this.page.y += this.sizes.gap / 2
				this.rule([0.83, 0.83, 0.85])
				this.page.y += this.sizes.gap
				break
			case 'pairs': {
				if (block.caption) this.caption(block.caption)
				const cols = block.columns
				const cellWidth = (this.column - this.sizes.gap) / cols
				for (let i = 0; i < block.pairs.length; i += cols) {
					const rowPairs = block.pairs.slice(i, i + cols)
					const rowHeight = this.sizes.small * 1.5 + this.sizes.base * 1.5
					this.ensure(rowHeight)
					const top = this.page.y
					let bottom = top
					rowPairs.forEach((pair, col) => {
						this.page.y = top
						const x = MARGIN + col * (cellWidth + this.sizes.gap)
						this.line(pair.label, {
							size: this.sizes.small,
							color: [0.4, 0.4, 0.4],
							x,
							width: cellWidth,
							advance: this.sizes.small * 1.5,
						})
						this.paragraph(pair.value, {
							size: this.sizes.base,
							x,
							width: cellWidth,
						})
						bottom = Math.max(bottom, this.page.y)
					})
					// Every cell in the row started at the same cursor; the row's height
					// is the tallest of them, so a wrapped value pushes its neighbours
					// down rather than overlapping the next row.
					this.page.y = bottom
				}
				this.page.y += this.sizes.gap / 2
				break
			}
			case 'table': {
				if (block.caption) this.caption(block.caption)
				const widths = this.columnWidths(block)
				const rowHeight = this.sizes.base * 1.9
				const headerHeight = this.sizes.small * 1.9
				this.ensure(headerHeight + rowHeight)
				this.tableHeader(block, widths, headerHeight)
				for (const row of block.rows) {
					if (this.page.y + rowHeight > this.maxY) {
						this.newPage()
						// The header is re-emitted on every continuation. A page of
						// unlabelled columns is a document somebody has to guess at.
						this.tableHeader(block, widths, headerHeight)
					}
					const top = this.page.y
					row.forEach((cell, i) => {
						const col = block.columns[i]
						if (!col) return
						const width = widths[i] ?? 0
						this.page.y = top
						this.line(
							truncateToWidth(
								cell,
								this.face('regular'),
								this.sizes.base,
								width,
							),
							{
								size: this.sizes.base,
								x: this.columnX(widths, i),
								width,
								align: col.align,
								advance: rowHeight,
							},
						)
					})
					this.page.y = top + rowHeight
					this.rule([0.87, 0.87, 0.89], 0.4)
				}
				if (block.note) {
					this.page.y += this.sizes.gap / 2
					this.paragraph(block.note, {
						size: this.sizes.small,
						color: [0.4, 0.4, 0.4],
					})
				}
				this.page.y += this.sizes.gap
				break
			}
		}
	}

	private tableHeader(
		block: Extract<DocumentBlock, { kind: 'table' }>,
		widths: number[],
		height: number,
	): void {
		const top = this.page.y
		block.columns.forEach((col, i) => {
			this.page.y = top
			this.line(col.label.toUpperCase(), {
				size: this.sizes.small,
				weight: 'bold',
				color: [0.35, 0.35, 0.35],
				x: this.columnX(widths, i),
				width: widths[i] ?? 0,
				align: col.align,
				advance: height,
			})
		})
		this.page.y = top + height
		this.rule(this.accent, 0.8)
	}

	private columnX(widths: number[], index: number): number {
		let x = MARGIN
		for (let i = 0; i < index; i++) x += (widths[i] ?? 0) + this.sizes.gap
		return x
	}

	/**
	 * Share the text column between a table's columns.
	 *
	 * Proportional to the widest content in each, with a floor at the header's own
	 * width so a column can never be narrower than its label. Content-driven
	 * rather than equal shares because an invoice's `Description` and its `Qty`
	 * are not the same size, and equal columns would truncate the one that
	 * carries the meaning to leave room for one that carries two characters.
	 */
	private columnWidths(
		block: Extract<DocumentBlock, { kind: 'table' }>,
	): number[] {
		const gaps = this.sizes.gap * Math.max(0, block.columns.length - 1)
		const available = this.column - gaps
		const natural = block.columns.map((col, i) => {
			let widest = this.face('bold').measure(
				col.label.toUpperCase(),
				this.sizes.small,
			)
			for (const row of block.rows) {
				const cell = row[i]
				if (cell === undefined) continue
				widest = Math.max(
					widest,
					this.face('regular').measure(cell, this.sizes.base),
				)
			}
			return widest
		})
		const total = natural.reduce((a, b) => a + b, 0)
		if (total <= available || total === 0) {
			// Everything fits at its natural width; the slack goes to the first
			// column, which is the description in every document this vocabulary can
			// express.
			const widths = [...natural]
			if (widths.length > 0) widths[0] = (widths[0] ?? 0) + (available - total)
			return widths
		}
		return natural.map((w) => (w / total) * available)
	}

	/** The finished pages, as content-stream text. */
	get contents(): string[] {
		return this.pages.map((page) => page.ops.join('\n'))
	}

	get pageSize(): { width: number; height: number } {
		return { width: this.width, height: this.height }
	}
}

// ===========================================================================
// Serialization
// ===========================================================================

/** Latin-1 bytes for a PDF source string. */
function bytes(text: string): number[] {
	const out: number[] = []
	for (let i = 0; i < text.length; i++) out.push(text.charCodeAt(i) & 0xff)
	return out
}

/**
 * Render a compiled layout as a PDF file.
 *
 * Pure and clock-free: the returned bytes are a function of the arguments alone.
 * `documentPdf(x) === documentPdf(x)` byte for byte, which is the determinism
 * criterion the issue states, and which is asserted rather than claimed in
 * `document-pdf.test.ts`.
 */
export function documentPdf(
	layout: DocumentLayout,
	style: DocumentStyle,
	pageSize: DocumentPageSize,
	opts: {
		/**
		 * A font the deployment bound. Absent — the default and what
		 * every existing caller passes — is the base-14 path, byte-for-byte
		 * unchanged.
		 */
		font?: BoundFont
	} = {},
): Uint8Array {
	const writer = new DocumentWriter(style, pageSize, opts.font)
	// Laying out is also the glyph-collection pass when a font is bound, so this
	// has to happen before the font objects are built. See `EmbeddedFace`.
	writer.write(layout)
	const contents = writer.contents
	const { width, height } = writer.pageSize
	const family = PDF_FONT_FAMILIES[style.font]

	// Object numbering, fixed so the cross-reference table can be built in one
	// pass: 1 catalog, 2 pages, 3 info, 4/5 the two fonts, then — when a font is
	// bound — five objects per face, then a page object and a content stream for
	// each page. The embedded objects sit before the pages rather than after so
	// that the page numbering is a single arithmetic expression either way.
	const objects: string[] = []
	const pageCount = contents.length
	// Two faces × (descendant, descriptor, font file, ToUnicode); the two `/Type0`
	// dictionaries are objects 4 and 5, which is what the pages already point at.
	// Four each, and none for a bold face that IS the regular one — see the
	// writer's constructor.
	const sharedFace =
		writer.embedded !== undefined &&
		writer.embedded.bold === writer.embedded.regular
	const embeddedSlots = writer.embedded ? (sharedFace ? 4 : 8) : 0
	const firstPageObj = 6 + embeddedSlots
	const pageIds = contents.map((_, i) => firstPageObj + i * 2)
	const contentIds = contents.map((_, i) => firstPageObj + i * 2 + 1)

	objects[1] = `<< /Type /Catalog /Pages 2 0 R >>`
	objects[2] = `<< /Type /Pages /Kids [${pageIds.map((id) => `${id} 0 R`).join(' ')}] /Count ${pageCount} >>`
	// The Info dictionary carries a title and nothing else. **No /CreationDate
	// and no /ModDate**: they are the only nondeterminism a PDF writer normally
	// has, and the issue asks for them to be declared and excluded rather than
	// tolerated. A document's date is a field on the row.
	objects[3] = `<< /Title ${infoString(layout.title)} /Producer (maxstack) >>`
	if (writer.embedded) {
		// The regular face takes 6–9, bold 10–13; both `/Type0` dictionaries land
		// at 4 and 5 so `/F1` and `/F2` mean the same thing on every page whether
		// or not a font is bound.
		const name = (opts.font as BoundFont).name
		const regular = embeddedFontObjects(
			writer.embedded.regular,
			sharedFace ? name : `${name}-Regular`,
			{ type0: 4, descendant: 6, descriptor: 7, fontFile: 8, toUnicode: 9 },
		)
		objects[4] = regular.type0
		objects[6] = regular.descendant
		objects[7] = regular.descriptor
		objects[8] = regular.fontFile
		objects[9] = regular.toUnicode
		if (sharedFace) {
			// `/F2` IS `/F1`. Bold text is drawn in the regular face either way, so
			// a second dictionary would give the reader a second name for one font
			// and — built from a second subset — a second copy of it.
			objects[5] = regular.type0
		} else {
			const bold = embeddedFontObjects(writer.embedded.bold, `${name}-Bold`, {
				type0: 5,
				descendant: 10,
				descriptor: 11,
				fontFile: 12,
				toUnicode: 13,
			})
			objects[5] = bold.type0
			objects[10] = bold.descendant
			objects[11] = bold.descriptor
			objects[12] = bold.fontFile
			objects[13] = bold.toUnicode
		}
	} else {
		objects[4] = `<< /Type /Font /Subtype /Type1 /BaseFont /${family.regular} /Encoding /WinAnsiEncoding >>`
		objects[5] = `<< /Type /Font /Subtype /Type1 /BaseFont /${family.bold} /Encoding /WinAnsiEncoding >>`
	}

	contents.forEach((stream, i) => {
		const pageId = pageIds[i] ?? 0
		const contentId = contentIds[i] ?? 0
		objects[pageId] =
			`<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${n2(width)} ${n2(height)}] ` +
			`/Resources << /Font << /F1 4 0 R /F2 5 0 R >> >> /Contents ${contentId} 0 R >>`
		objects[contentId] =
			`<< /Length ${bytes(stream).length} >>\nstream\n${stream}\nendstream`
	})

	const out: number[] = []
	// Appended one at a time rather than spread: an embedded font stream is
	// megabytes, and `out.push(...huge)` is a call with a million arguments,
	// which overflows the stack. It did.
	const push = (text: string) => {
		for (let i = 0; i < text.length; i++) out.push(text.charCodeAt(i) & 0xff)
	}
	push('%PDF-1.4\n')
	// A binary comment line, so tools that sniff the first bytes classify the
	// file as binary rather than text and never "helpfully" convert its newlines.
	out.push(0x25, 0xe2, 0xe3, 0xcf, 0xd3, 0x0a)

	const offsets: number[] = []
	const highest = objects.length - 1
	for (let id = 1; id <= highest; id++) {
		const body = objects[id]
		if (body === undefined) continue
		offsets[id] = out.length
		push(`${id} 0 obj\n${body}\nendobj\n`)
	}

	const xrefOffset = out.length
	push(`xref\n0 ${highest + 1}\n`)
	push('0000000000 65535 f \n')
	for (let id = 1; id <= highest; id++)
		push(`${String(offsets[id] ?? 0).padStart(10, '0')} 00000 n \n`)
	push(`trailer\n<< /Size ${highest + 1} /Root 1 0 R /Info 3 0 R >>\n`)
	push(`startxref\n${xrefOffset}\n%%EOF\n`)

	return Uint8Array.from(out)
}
