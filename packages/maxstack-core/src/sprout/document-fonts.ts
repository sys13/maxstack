/**
 * Base-14 font metrics and WinAnsi encoding for the PDF backend.
 *
 * ## Why this file exists at all
 *
 * The issue gates PDF generation hard: *"PDF generation must not drag a browser
 * into the runtime image."* A headless Chromium is 150–300MB, changes the deploy
 * story, and produces bytes that vary with the browser build — so the decision
 * recorded in `docs/documents.md` is to write the PDF directly. Writing one
 * directly means the writer has to answer two questions a browser would have
 * answered: **how wide is this text** (for wrapping and right-alignment) and
 * **which byte is this character**.
 *
 * The answer to both is the **base-14**: the fourteen fonts every conforming PDF
 * reader is required to have, which therefore need no font file, no embedding,
 * no subsetting and no license. That is what makes the image-size delta of this
 * feature zero rather than small.
 *
 * ## The honest limitation
 *
 * The base-14 fonts are encoded with **WinAnsiEncoding**, which holds 224
 * glyphs: ASCII, Latin-1, and a handful of typographic extras. Text outside that
 * set — Greek, Cyrillic, CJK, Devanagari — has no byte to be written as, and
 * {@link toWinAnsi} substitutes `?`. **The HTML target has no such limit**, so a
 * deployment whose documents are not Latin-script should deliver HTML today.
 * Lifting it means embedding and subsetting a Unicode font, which is a real
 * capability with a real image cost, and it is scoped as its own follow-up
 * rather than smuggled in as a `package.json` line. This is stated in
 * `docs/documents.md` and in the evidence file, not buried here.
 *
 * ## Where the widths come from, and what an error in them would cost
 *
 * The tables below are the Adobe AFM character widths for the standard fonts, in
 * 1/1000 em. Two properties make them checkable rather than trusted, and
 * `document-pdf.test.ts` asserts both: every digit in a given font has the same
 * width (the base-14 fonts have tabular figures, which is also what makes a
 * printed column of amounts line up), and Courier is 600 for every glyph.
 *
 * Accented Latin letters are not tabulated. They do not need to be: in these
 * fonts an accented letter has **exactly its base letter's width** — `eacute` is
 * `e`, `ccedilla` is `c` — because the accent is drawn above the glyph box
 * rather than beside it. {@link WINANSI_WIDTH_BASE} states that mapping
 * explicitly instead of hiding it in a fallback.
 *
 * And the blast radius is bounded by construction: widths are used only for line
 * breaking and right-alignment. An error in one would move a wrap point or
 * misalign a column by a hair. It cannot change a value, drop a row, or alter
 * what the document says.
 */

/** The four base-14 faces this backend uses. Chosen by the theme's font. */
export type DocumentPdfFont =
	| 'Helvetica'
	| 'Helvetica-Bold'
	| 'Times-Roman'
	| 'Times-Bold'
	| 'Courier'
	| 'Courier-Bold'

/** Theme font → the regular/bold pair it prints in. */
export const PDF_FONT_FAMILIES: Record<
	'sans' | 'serif' | 'mono',
	{ regular: DocumentPdfFont; bold: DocumentPdfFont }
> = {
	sans: { regular: 'Helvetica', bold: 'Helvetica-Bold' },
	serif: { regular: 'Times-Roman', bold: 'Times-Bold' },
	mono: { regular: 'Courier', bold: 'Courier-Bold' },
}

/** Widths for ASCII 32–126, in 1/1000 em, indexed by `code - 32`. */
const HELVETICA: readonly number[] = [
	278, 278, 355, 556, 556, 889, 667, 191, 333, 333, 389, 584, 278, 333, 278,
	278, 556, 556, 556, 556, 556, 556, 556, 556, 556, 556, 278, 278, 584, 584,
	584, 556, 1015, 667, 667, 722, 722, 667, 611, 778, 722, 278, 500, 667, 556,
	833, 722, 778, 667, 778, 722, 667, 611, 722, 667, 944, 667, 667, 611, 278,
	278, 278, 469, 556, 333, 556, 556, 500, 556, 556, 278, 556, 556, 222, 222,
	500, 222, 833, 556, 556, 556, 556, 333, 500, 278, 556, 500, 722, 500, 500,
	500, 334, 260, 334, 584,
]

const HELVETICA_BOLD: readonly number[] = [
	278, 333, 474, 556, 556, 889, 722, 238, 333, 333, 389, 584, 278, 333, 278,
	278, 556, 556, 556, 556, 556, 556, 556, 556, 556, 556, 333, 333, 584, 584,
	584, 611, 975, 722, 722, 722, 722, 667, 611, 778, 722, 278, 556, 722, 611,
	833, 722, 778, 667, 778, 722, 667, 611, 722, 667, 944, 667, 667, 611, 333,
	278, 333, 584, 556, 333, 556, 611, 556, 611, 556, 333, 611, 611, 278, 278,
	556, 278, 889, 611, 611, 611, 611, 389, 556, 333, 611, 556, 778, 556, 556,
	500, 389, 280, 389, 584,
]

const TIMES_ROMAN: readonly number[] = [
	250, 333, 408, 500, 500, 833, 778, 180, 333, 333, 500, 564, 250, 333, 250,
	278, 500, 500, 500, 500, 500, 500, 500, 500, 500, 500, 278, 278, 564, 564,
	564, 444, 921, 722, 667, 667, 722, 611, 556, 722, 722, 333, 389, 722, 611,
	889, 722, 722, 556, 722, 667, 556, 611, 722, 722, 944, 722, 722, 611, 333,
	278, 333, 469, 500, 333, 444, 500, 444, 500, 444, 333, 500, 500, 278, 278,
	500, 278, 778, 500, 500, 500, 500, 333, 389, 278, 500, 500, 722, 500, 500,
	444, 480, 200, 480, 541,
]

const TIMES_BOLD: readonly number[] = [
	250, 333, 555, 500, 500, 1000, 833, 278, 333, 333, 500, 570, 250, 333, 250,
	278, 500, 500, 500, 500, 500, 500, 500, 500, 500, 500, 333, 333, 570, 570,
	570, 500, 930, 722, 667, 722, 722, 667, 611, 778, 778, 389, 500, 778, 667,
	944, 722, 778, 611, 778, 722, 556, 667, 722, 722, 1000, 722, 722, 667, 333,
	278, 333, 581, 500, 333, 500, 556, 444, 556, 444, 333, 500, 556, 278, 333,
	556, 278, 833, 556, 500, 556, 556, 444, 389, 333, 556, 500, 722, 500, 500,
	444, 394, 220, 394, 520,
]

const ASCII_WIDTHS: Record<DocumentPdfFont, readonly number[] | null> = {
	Helvetica: HELVETICA,
	'Helvetica-Bold': HELVETICA_BOLD,
	'Times-Roman': TIMES_ROMAN,
	'Times-Bold': TIMES_BOLD,
	// Monospace: every glyph, in both weights. Stated as `null` + a constant
	// rather than as a 95-entry array of the same number, so the fact that it *is*
	// monospace is visible instead of being a coincidence of the data.
	Courier: null,
	'Courier-Bold': null,
}

/** Every Courier glyph. The definition of monospace, and asserted by a test. */
export const COURIER_WIDTH = 600

/**
 * WinAnsi codes whose glyph is an accented form of an ASCII letter, mapped to
 * that letter — which is also its width, exactly, in every base-14 font.
 *
 * Written out rather than derived from Unicode normalization because a
 * dependency-free module should not carry a normalization table, and because
 * being able to read the mapping is the point: this is the claim the widths rest
 * on, so it is legible rather than clever.
 */
const WINANSI_WIDTH_BASE: Record<number, string> = {
	192: 'A',
	193: 'A',
	194: 'A',
	195: 'A',
	196: 'A',
	197: 'A',
	199: 'C',
	200: 'E',
	201: 'E',
	202: 'E',
	203: 'E',
	204: 'I',
	205: 'I',
	206: 'I',
	207: 'I',
	209: 'N',
	210: 'O',
	211: 'O',
	212: 'O',
	213: 'O',
	214: 'O',
	216: 'O',
	217: 'U',
	218: 'U',
	219: 'U',
	220: 'U',
	221: 'Y',
	224: 'a',
	225: 'a',
	226: 'a',
	227: 'a',
	228: 'a',
	229: 'a',
	231: 'c',
	232: 'e',
	233: 'e',
	234: 'e',
	235: 'e',
	236: 'i',
	237: 'i',
	238: 'i',
	239: 'i',
	241: 'n',
	242: 'o',
	243: 'o',
	244: 'o',
	245: 'o',
	246: 'o',
	248: 'o',
	249: 'u',
	250: 'u',
	251: 'u',
	252: 'u',
	253: 'y',
	255: 'y',
	// Punctuation and symbols whose width matches a tabulated ASCII glyph
	// closely enough that no reader would see the difference at 11pt.
	160: ' ',
	173: '-',
	150: '-',
	151: '-',
	145: "'",
	146: "'",
	147: '"',
	148: '"',
	149: '-',
	133: '.',
	128: 'E',
	171: '<',
	187: '>',
}

/**
 * The width of one WinAnsi byte in 1/1000 em.
 *
 * Anything with no tabulated or derived width falls back to the width of `n`,
 * which is close to the average glyph width in every one of these fonts. The
 * fallback only affects wrapping, per the module comment.
 */
export function glyphWidth(font: DocumentPdfFont, code: number): number {
	const table = ASCII_WIDTHS[font]
	if (table === null) return COURIER_WIDTH
	if (code >= 32 && code <= 126) return table[code - 32] ?? 0
	const base = WINANSI_WIDTH_BASE[code]
	if (base !== undefined) return table[base.charCodeAt(0) - 32] ?? 0
	return table['n'.charCodeAt(0) - 32] ?? 0
}

/**
 * Unicode code points outside Latin-1 that WinAnsi *does* hold, in the 0x80–0x9F
 * region Latin-1 leaves as control codes. These are the characters real text
 * actually contains — curly quotes a word processor inserted, an em dash, a euro
 * sign — so mapping them is the difference between an invoice that reads
 * correctly and one littered with question marks.
 */
const WINANSI_EXTRAS: Record<number, number> = {
	8364: 0x80, // €
	8218: 0x82, // ‚
	402: 0x83, // ƒ
	8222: 0x84, // „
	8230: 0x85, // …
	8224: 0x86, // †
	8225: 0x87, // ‡
	710: 0x88, // ˆ
	8240: 0x89, // ‰
	352: 0x8a, // Š
	8249: 0x8b, // ‹
	338: 0x8c, // Œ
	381: 0x8e, // Ž
	8216: 0x91, // '
	8217: 0x92, // '
	8220: 0x93, // "
	8221: 0x94, // "
	8226: 0x95, // •
	8211: 0x96, // –
	8212: 0x97, // —
	732: 0x98, // ˜
	8482: 0x99, // ™
	353: 0x9a, // š
	8250: 0x9b, // ›
	339: 0x9c, // œ
	382: 0x9e, // ž
	376: 0x9f, // Ÿ
}

/** What an unrepresentable character becomes. See the module comment. */
export const WINANSI_REPLACEMENT = 0x3f // '?'

/**
 * Encode a string as WinAnsi bytes.
 *
 * Substitution is per *code point*, so a surrogate pair (an emoji) becomes one
 * `?` rather than two — a small thing, but the alternative reads as corruption
 * rather than as a character this document cannot show.
 */
export function toWinAnsi(text: string): number[] {
	const out: number[] = []
	for (const char of text) {
		const code = char.codePointAt(0) ?? 0
		if (code === 0x0a || code === 0x0d) {
			out.push(0x20)
			continue
		}
		if (code >= 0x20 && code <= 0x7e) out.push(code)
		else if (code >= 0xa0 && code <= 0xff) out.push(code)
		else out.push(WINANSI_EXTRAS[code] ?? WINANSI_REPLACEMENT)
	}
	return out
}

/**
 * What the layout engine needs from a font: how wide is this text, and what does
 * it look like inside a PDF content stream.
 *
 * Two implementations, and the abstraction exists because they answer the second
 * question *incompatibly*. A base-14 font is a simple font: one byte per glyph,
 * written as a literal `(string)`. An embedded font is addressed through
 * `Identity-H`, which is **two bytes per glyph id**, written as a hex
 * `<0041004200>` — so every text-showing operator changes shape depending on
 * which is in use. Threading a union through the writer instead would put that
 * branch at every call site; this puts it in one object built once.
 */
export interface DocumentFace {
	/** The printed width of `text` at `sizePt`, in points. */
	measure(text: string, sizePt: number): number
	/**
	 * `text` as a complete PDF string operand, delimiters included.
	 *
	 * Complete rather than "the bytes", because the delimiters are part of the
	 * difference: `(…)` and `<…>` are not interchangeable, and a caller that
	 * wrapped the result itself would have to know which font it had.
	 */
	operand(text: string): string
}

/** The printed width of a string at a size, in points. */
export function textWidth(
	text: string,
	font: DocumentPdfFont,
	sizePt: number,
): number {
	let total = 0
	for (const code of toWinAnsi(text)) total += glyphWidth(font, code)
	return (total * sizePt) / 1000
}

/**
 * Escape WinAnsi bytes as a PDF literal string.
 *
 * The three characters that must be escaped inside `( … )` are the backslash and
 * both parentheses. Everything else is written as its byte, including the high
 * range — which is why the PDF is assembled as bytes rather than as a JavaScript
 * string.
 */
function winAnsiOperand(text: string): string {
	let out = '('
	for (const code of toWinAnsi(text)) {
		if (code === 0x28 || code === 0x29 || code === 0x5c) out += '\\'
		out += String.fromCharCode(code)
	}
	return `${out})`
}

/** Accept either a base-14 font name or a face, and answer widths. The union
 * exists so `wrapText` and `truncateToWidth` did not need two call paths and two
 * sets of tests; a face is the general case and a name is the common one. */
function measurer(
	font: DocumentPdfFont | DocumentFace,
): (text: string, sizePt: number) => number {
	return typeof font === 'string'
		? (text, sizePt) => textWidth(text, font, sizePt)
		: (text, sizePt) => font.measure(text, sizePt)
}

/** The base-14 face for one of the standard fonts — the behaviour that shipped
 * with #176, unchanged, and still what a deployment that binds nothing gets. */
export function base14Face(font: DocumentPdfFont): DocumentFace {
	return {
		measure: (text, sizePt) => textWidth(text, font, sizePt),
		operand: winAnsiOperand,
	}
}

/**
 * Break text into lines that fit `maxWidth`, on spaces where possible.
 *
 * A word longer than the line — a URL, an unbroken product code — is split
 * character by character rather than allowed to run off the page. Overflowing
 * the margin is the failure that turns "the total is 1,240.00" into "the total
 * is 1,24", and it is invisible until somebody prints it.
 */
export function wrapText(
	text: string,
	font: DocumentPdfFont | DocumentFace,
	sizePt: number,
	maxWidth: number,
): string[] {
	const measure = measurer(font)
	const lines: string[] = []
	for (const paragraph of text.split('\n')) {
		let line = ''
		for (const word of paragraph.split(/\s+/)) {
			if (word === '') continue
			const candidate = line === '' ? word : `${line} ${word}`
			if (measure(candidate, sizePt) <= maxWidth) {
				line = candidate
				continue
			}
			if (line !== '') lines.push(line)
			if (measure(word, sizePt) <= maxWidth) {
				line = word
				continue
			}
			let chunk = ''
			for (const char of word) {
				if (measure(chunk + char, sizePt) > maxWidth && chunk !== '') {
					lines.push(chunk)
					chunk = char
				} else chunk += char
			}
			line = chunk
		}
		lines.push(line)
	}
	// A trailing empty line is a blank row on the page nobody asked for; an
	// interior one is a deliberate paragraph break and is kept.
	while (lines.length > 1 && lines[lines.length - 1] === '') lines.pop()
	return lines.length === 0 ? [''] : lines
}

/**
 * Shorten text to fit a width, ending in an ellipsis.
 *
 * Only used for table cells, where wrapping would make rows different heights
 * and a document's line items should be one line each. The ellipsis is the
 * single-character `…`, which WinAnsi holds.
 */
export function truncateToWidth(
	text: string,
	font: DocumentPdfFont | DocumentFace,
	sizePt: number,
	maxWidth: number,
): string {
	const measure = measurer(font)
	if (measure(text, sizePt) <= maxWidth) return text
	let out = ''
	for (const char of text) {
		if (measure(`${out}${char}…`, sizePt) > maxWidth) break
		out += char
	}
	return `${out}…`
}
