/**
 * The document renderer's tests.
 *
 * They are organized around the four properties the issue gates on, rather than
 * around the modules: **one layout, two backends** (they cannot disagree about
 * content), **determinism** (same input ⇒ same bytes), **no silent truncation**,
 * and **no browser** (the PDF is written here, and it is a real PDF).
 */

import { describe, expect, it } from 'vitest'
import {
	COURIER_WIDTH,
	glyphWidth,
	textWidth,
	toWinAnsi,
	truncateToWidth,
	WINANSI_REPLACEMENT,
	wrapText,
} from './document-fonts.ts'
import { documentHtml, escapeHtml } from './document-html.ts'
import { documentPdf } from './document-pdf.ts'
import {
	compileDocument,
	DOCUMENT_EMPTY,
	type DocumentData,
	type DocumentPlan,
	type DocumentStyle,
	formatDocumentValue,
	MAX_DOCUMENT_TABLE_ROWS,
	resolveDocumentPath,
	resolveDocumentText,
} from './documents.ts'

const style: DocumentStyle = {
	font: 'sans',
	accent: '#3b82f6',
	density: 'comfortable',
	typeScale: 'default',
}

const invoicePlan: DocumentPlan = {
	key: 'invoice',
	description: 'A branded invoice.',
	resource: 'invoice',
	// Declared downloadable — a template without it has no URL.
	download: true,
	pageSize: 'a4',
	style,
	values: {
		number: { column: 'number', label: 'Number', type: 'string' },
		dueDate: { column: 'dueDate', label: 'Due date', type: 'date' },
		total: { column: 'total', label: 'Total', type: 'number' },
		status: {
			column: 'status',
			label: 'Status',
			type: 'enum',
			options: { paid: 'Paid', draft: 'Draft' },
		},
	},
	sections: [
		{ kind: 'heading', level: 1, text: 'Invoice {number}' },
		{
			kind: 'fields',
			columns: 2,
			caption: 'Details',
			fields: [
				{ column: 'dueDate', label: 'Due date', type: 'date' },
				{
					column: 'status',
					label: 'Status',
					type: 'enum',
					options: { paid: 'Paid' },
				},
			],
		},
		{
			kind: 'table',
			caption: 'Line items',
			resource: 'lineitem',
			via: 'invoiceId',
			direction: 'asc',
			fields: [
				{ column: 'label', label: 'Description', type: 'string' },
				{ column: 'amount', label: 'Amount', type: 'number' },
			],
		},
		{ kind: 'rule' },
		{
			kind: 'fields',
			columns: 1,
			fields: [{ column: 'total', label: 'Total', type: 'number' }],
		},
		{ kind: 'slot', name: 'remittance' },
	],
}

const data: DocumentData = {
	row: {
		id: 'i1',
		number: 'INV-1042',
		dueDate: '2026-08-15T00:00:00.000Z',
		status: 'paid',
		total: 1234.5,
	},
	related: {
		2: [
			{ label: 'Design work', amount: 1000 },
			{ label: 'Revisions', amount: 234.5 },
		],
	},
}

describe('value formatting — one implementation, both backends', () => {
	it('prints a date as YYYY-MM-DD, off the ISO string rather than a Date', () => {
		// A spec `date` is a timestamp WITHOUT a zone. Going through `new Date()`
		// would apply the process offset and could move an invoice a day.
		expect(
			formatDocumentValue('2026-08-15T00:00:00.000Z', { type: 'date' }),
		).toBe('2026-08-15')
		expect(formatDocumentValue('2026-01-02', { type: 'date' })).toBe(
			'2026-01-02',
		)
	})

	it('groups number digits without Intl, so the bytes do not depend on the locale', () => {
		expect(formatDocumentValue(1234567.25, { type: 'number' })).toBe(
			'1,234,567.25',
		)
		expect(formatDocumentValue(-1234, { type: 'number' })).toBe('-1,234')
		// No forced decimals: this layer does not know a column is money.
		expect(formatDocumentValue(3, { type: 'number' })).toBe('3')
	})

	it('prints booleans as Yes/No and enums by their declared label', () => {
		expect(formatDocumentValue(true, { type: 'boolean' })).toBe('Yes')
		expect(formatDocumentValue(false, { type: 'boolean' })).toBe('No')
		expect(
			formatDocumentValue('paid', { type: 'enum', options: { paid: 'Paid' } }),
		).toBe('Paid')
		// An option renamed in the UI but not here still prints the stored value
		// rather than a blank.
		expect(formatDocumentValue('void', { type: 'enum', options: {} })).toBe(
			'void',
		)
	})

	it('prints an absent value as an em dash, never as "null"', () => {
		for (const value of [null, undefined, ''])
			expect(formatDocumentValue(value, { type: 'string' })).toBe(
				DOCUMENT_EMPTY,
			)
	})

	it('resolves a placeholder through the same formatter the fields use', () => {
		expect(
			resolveDocumentText(
				'Due {dueDate} — {total}',
				data.row,
				invoicePlan.values,
			),
		).toBe('Due 2026-08-15 — 1,234.5')
	})

	it('prints an em dash for a placeholder whose field was rejected after declaring', () => {
		// The validator refuses unresolvable placeholders at declare time, so this
		// branch means the field went away underneath. A gap is noticed; a literal
		// "{clientName}" on an invoice is a customer support ticket.
		expect(
			resolveDocumentText('Hello {gone}', data.row, invoicePlan.values),
		).toBe(`Hello ${DOCUMENT_EMPTY}`)
	})
})

describe('object keys', () => {
	it('slugs a placeholder so a value cannot create a directory level or climb out', () => {
		const values = {
			number: { column: 'number', label: 'n', type: 'string' as const },
		}
		expect(
			resolveDocumentPath(
				'invoices/{number}.pdf',
				{ number: '../../etc' },
				values,
			),
		).toBe('invoices/etc.pdf')
		expect(
			resolveDocumentPath('invoices/{number}.pdf', { number: 'a/b' }, values),
		).toBe('invoices/a-b.pdf')
	})

	it('never produces an empty segment', () => {
		const values = {
			number: { column: 'number', label: 'n', type: 'string' as const },
		}
		expect(
			resolveDocumentPath('invoices/{number}.pdf', { number: '///' }, values),
		).toBe('invoices/untitled.pdf')
	})
})

describe('compilation', () => {
	it('compiles one layout that both backends read', () => {
		const layout = compileDocument(invoicePlan, data)
		expect(layout.title).toBe('Invoice INV-1042')
		expect(layout.blocks.map((b) => b.kind)).toEqual([
			'heading',
			'pairs',
			'table',
			'rule',
			'pairs',
		])
		const table = layout.blocks[2]
		expect(table?.kind === 'table' && table.rows).toEqual([
			['Design work', '1,000'],
			['Revisions', '234.5'],
		])
		// Numeric columns are right-aligned, in the layout rather than per backend.
		expect(
			table?.kind === 'table' && table.columns.map((c) => c.align),
		).toEqual(['left', 'right'])
	})

	it('renders an unfilled slot as nothing, and a filled one in place', () => {
		const filled = compileDocument(invoicePlan, {
			...data,
			slots: {
				remittance: [{ kind: 'paragraph', text: 'Pay to account 12345.' }],
			},
		})
		expect(filled.blocks.at(-1)).toEqual({
			kind: 'paragraph',
			text: 'Pay to account 12345.',
		})
	})

	it('states a truncation on the page rather than dropping rows silently', () => {
		const many = Array.from(
			{ length: MAX_DOCUMENT_TABLE_ROWS + 7 },
			(_, i) => ({
				label: `Line ${i}`,
				amount: i,
			}),
		)
		const layout = compileDocument(invoicePlan, {
			...data,
			related: { 2: many },
		})
		const table = layout.blocks[2]
		expect(table?.kind === 'table' && table.rows).toHaveLength(
			MAX_DOCUMENT_TABLE_ROWS,
		)
		expect(table?.kind === 'table' && table.note).toBe(
			`Showing the first ${MAX_DOCUMENT_TABLE_ROWS} of ${many.length} rows.`,
		)
	})

	it('is pure — the same plan and rows compile to a deeply equal layout', () => {
		expect(compileDocument(invoicePlan, data)).toEqual(
			compileDocument(invoicePlan, data),
		)
	})
})

describe('the HTML backend', () => {
	const html = documentHtml(compileDocument(invoicePlan, data), style, 'a4')

	it('is a standalone print-ready document with the declared paper', () => {
		expect(html.startsWith('<!doctype html>')).toBe(true)
		expect(html).toContain('@page { size: A4; margin: 18mm; }')
		expect(html).toContain('<title>Invoice INV-1042</title>')
	})

	it('makes no external request of any kind', () => {
		// The rule the module states: a document that renders differently depending
		// on whether the reader was online is not an archive.
		expect(html).not.toMatch(/<link\b/i)
		expect(html).not.toMatch(/<script\b/i)
		expect(html).not.toMatch(/https?:\/\//)
		expect(html).not.toMatch(/@import/)
		expect(html).not.toMatch(/url\(/)
	})

	it('carries the theme rather than a document-specific palette', () => {
		expect(html).toContain('--doc-accent: #3b82f6')
		expect(
			documentHtml(
				compileDocument(invoicePlan, data),
				{ ...style, accent: '#ef4444' },
				'a4',
			),
		).toContain('--doc-accent: #ef4444')
	})

	it('escapes every interpolated string, including the ones from the spec', () => {
		expect(escapeHtml('<b>&"\'')).toBe('&lt;b&gt;&amp;&quot;&#39;')
		const hostile = documentHtml(
			compileDocument(invoicePlan, {
				...data,
				row: { ...data.row, number: '<script>alert(1)</script>' },
			}),
			style,
			'a4',
		)
		expect(hostile).not.toContain('<script>alert(1)</script>')
		expect(hostile).toContain('&lt;script&gt;')
	})

	it('is deterministic', () => {
		expect(documentHtml(compileDocument(invoicePlan, data), style, 'a4')).toBe(
			html,
		)
	})
})

describe('font metrics', () => {
	it('is monospace for Courier — the definition, asserted', () => {
		for (let code = 32; code <= 126; code++)
			expect(glyphWidth('Courier', code)).toBe(COURIER_WIDTH)
	})

	it('gives every digit the same width in every font — what makes an amount column line up', () => {
		for (const font of [
			'Helvetica',
			'Helvetica-Bold',
			'Times-Roman',
			'Times-Bold',
		] as const) {
			const widths = new Set(
				'0123456789'.split('').map((d) => glyphWidth(font, d.charCodeAt(0))),
			)
			expect(widths.size).toBe(1)
		}
	})

	it('gives an accented letter its base letter’s width', () => {
		// The claim the high-range widths rest on, stated as a test rather than
		// left as a comment.
		expect(glyphWidth('Helvetica', 0xe9)).toBe(
			glyphWidth('Helvetica', 'e'.charCodeAt(0)),
		)
		expect(glyphWidth('Times-Roman', 0xc7)).toBe(
			glyphWidth('Times-Roman', 'C'.charCodeAt(0)),
		)
	})

	it('maps the typographic extras real text contains, and replaces the rest', () => {
		expect(toWinAnsi('€')).toEqual([0x80])
		expect(toWinAnsi('“a”')).toEqual([0x93, 0x61, 0x94])
		expect(toWinAnsi('é')).toEqual([0xe9])
		// One replacement per code point, so an emoji is one `?` and not two.
		expect(toWinAnsi('🙂')).toEqual([WINANSI_REPLACEMENT])
		expect(toWinAnsi('日本')).toEqual([
			WINANSI_REPLACEMENT,
			WINANSI_REPLACEMENT,
		])
	})

	it('wraps on spaces and splits a word too long to fit', () => {
		const lines = wrapText('the quick brown fox', 'Helvetica', 10, 40)
		expect(lines.length).toBeGreaterThan(1)
		for (const line of lines)
			expect(textWidth(line, 'Helvetica', 10)).toBeLessThanOrEqual(40)
		const long = wrapText('a'.repeat(200), 'Helvetica', 10, 40)
		expect(long.length).toBeGreaterThan(1)
		for (const line of long)
			expect(textWidth(line, 'Helvetica', 10)).toBeLessThanOrEqual(40)
	})

	it('truncates a cell to fit rather than letting it run past the margin', () => {
		const out = truncateToWidth(
			'a very long description indeed',
			'Helvetica',
			10,
			40,
		)
		expect(out.endsWith('…')).toBe(true)
		expect(textWidth(out, 'Helvetica', 10)).toBeLessThanOrEqual(40)
	})
})

describe('the PDF backend', () => {
	const layout = compileDocument(invoicePlan, data)
	const pdf = documentPdf(layout, style, 'a4')
	const text = Buffer.from(pdf).toString('latin1')

	it('is a structurally complete PDF', () => {
		expect(text.startsWith('%PDF-1.4')).toBe(true)
		expect(text).toContain('/Type /Catalog')
		expect(text).toContain('/Type /Pages')
		expect(text).toContain('/Type /Page ')
		expect(text.trimEnd().endsWith('%%EOF')).toBe(true)
		expect(text).toContain('xref')
		expect(text).toContain('startxref')
	})

	it('has a cross-reference table whose offsets actually point at their objects', () => {
		// The one part of a PDF a reader will refuse outright if it is wrong, and
		// the one this writer computes by hand.
		const xrefAt = Number(/startxref\n(\d+)/.exec(text)?.[1])
		expect(text.slice(xrefAt, xrefAt + 4)).toBe('xref')
		const entries = [
			...text.slice(xrefAt).matchAll(/^(\d{10}) 00000 n $/gm),
		].map((m) => Number(m[1]))
		expect(entries.length).toBeGreaterThan(4)
		entries.forEach((offset, i) => {
			expect(text.slice(offset)).toMatch(new RegExp(`^${i + 1} 0 obj`))
		})
	})

	it('embeds no font and references only base-14 faces — the zero-image-cost claim', () => {
		expect(text).toContain('/BaseFont /Helvetica')
		expect(text).toContain('/BaseFont /Helvetica-Bold')
		expect(text).toContain('/Encoding /WinAnsiEncoding')
		expect(text).not.toContain('/FontFile')
		expect(text).not.toContain('/FontFile2')
		expect(text).not.toContain('/FontFile3')
	})

	it('carries no timestamp — the declared-and-excluded nondeterminism', () => {
		expect(text).not.toContain('/CreationDate')
		expect(text).not.toContain('/ModDate')
		// /ID is optional for an unencrypted file and is normally a hash of the
		// time; omitting it is what keeps the bytes a pure function of the input.
		expect(text).not.toContain('/ID [')
	})

	it('is byte-identical on a re-render', () => {
		expect(Buffer.from(documentPdf(layout, style, 'a4'))).toEqual(
			Buffer.from(pdf),
		)
	})

	it('holds the document’s text, escaped for PDF string syntax', () => {
		expect(text).toContain('(Invoice INV-1042)')
		expect(text).toContain('(Design work)')
		// A literal paren in data must be escaped or the content stream is corrupt
		// from that byte on.
		const parens = documentPdf(
			compileDocument(invoicePlan, {
				...data,
				row: { ...data.row, number: 'A(B)C\\D' },
			}),
			style,
			'a4',
		)
		expect(Buffer.from(parens).toString('latin1')).toContain(
			'(Invoice A\\(B\\)C\\\\D)',
		)
	})

	it('paginates a long table and repeats the header on every continuation', () => {
		const many = Array.from({ length: 120 }, (_, i) => ({
			label: `Line item number ${i}`,
			amount: i * 3,
		}))
		const long = documentPdf(
			compileDocument(invoicePlan, { ...data, related: { 2: many } }),
			style,
			'a4',
		)
		const longText = Buffer.from(long).toString('latin1')
		const pages = [...longText.matchAll(/\/Type \/Page /g)].length
		expect(pages).toBeGreaterThan(1)
		// One header per page: a page of unlabelled columns is a document somebody
		// has to guess at.
		expect([...longText.matchAll(/\(DESCRIPTION\)/g)].length).toBe(pages)
	})

	it('lays out both paper sizes at their real dimensions', () => {
		expect(text).toContain('/MediaBox [0 0 595.28 841.89]')
		expect(
			Buffer.from(documentPdf(layout, style, 'letter')).toString('latin1'),
		).toContain('/MediaBox [0 0 612 792]')
	})

	it('takes its typeface from the theme, not from a document setting', () => {
		expect(
			Buffer.from(
				documentPdf(layout, { ...style, font: 'serif' }, 'a4'),
			).toString('latin1'),
		).toContain('/BaseFont /Times-Roman')
	})
})

describe('the two backends cannot disagree about content', () => {
	it('prints the same values in HTML and in PDF', () => {
		const layout = compileDocument(invoicePlan, data)
		const html = documentHtml(layout, style, 'a4')
		const pdf = Buffer.from(documentPdf(layout, style, 'a4')).toString('latin1')
		// Neither backend reads the plan, so anything printed came from the layout.
		for (const value of [
			'Invoice INV-1042',
			'2026-08-15',
			'Design work',
			'1,234.5',
		]) {
			expect(html).toContain(escapeHtml(value))
			expect(pdf).toContain(value)
		}
	})
})
