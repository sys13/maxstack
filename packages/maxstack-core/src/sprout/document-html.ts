/**
 * The print-ready HTML backend for a compiled document layout.
 *
 * "Print-ready" is a specific claim and worth stating what it means here: the
 * output is a standalone document with an `@page` rule carrying the declared
 * paper size and margins, no navigation, no interactivity, no external
 * requests, and colors that survive a printer driver. Opening it and hitting
 * print gives you the document — not a screenshot of an app with a header on it,
 * which is what printing a generated admin page gives you and the reason the
 * corpus ask was off-surface.
 *
 * ## Why a string and not a component
 *
 * Three reasons, in order of how much they constrain the design:
 *
 * 1. **The same bytes are an email body.** The `email` bundle's template
 *    contract is `render(props) => string`, deliberately dependency-free. A
 *    document that were a React tree could not be one without a renderer in the
 *    mail path.
 * 2. **It must be renderable where React is not.** A stored copy is written by a
 *    background job; an attachment is built by the mailer. Neither is a request
 *    with a component tree around it.
 * 3. **It is the gate the issue names.** A component model here would be the
 *    beginning of the second UI system: components take props, props want
 *    types, types want a registry, and the registry is a framework. A function
 *    from a flat block list to a string cannot grow into one.
 *
 * ## Why the CSS is inlined and hand-written
 *
 * A strict rule, not a convenience: **no external requests**. A stylesheet link
 * or a webfont in an emailed attachment either fails to load or phones home from
 * inside somebody's mail client, and a document that renders differently
 * depending on whether the reader was online is not an archive. The theme's
 * tokens are written into a `:root` block from the resolved
 * {@link DocumentStyle}, so the document matches the product without either one
 * knowing about the other.
 */

import type {
	DocumentBlock,
	DocumentLayout,
	DocumentPageSize,
	DocumentStyle,
} from './documents.ts'

/**
 * Font stacks per theme font, chosen from what is installed rather than
 * downloaded. The theme's five personalities collapse to three here because a
 * printed page has three kinds of typeface and `rounded`/`humanist` are
 * distinctions webfonts make, not system stacks.
 */
const FONT_STACKS: Record<DocumentStyle['font'], string> = {
	sans: `-apple-system, BlinkMacSystemFont, "Segoe UI", Helvetica, Arial, sans-serif`,
	serif: `Georgia, "Times New Roman", Times, serif`,
	mono: `ui-monospace, "SFMono-Regular", Menlo, Consolas, monospace`,
}

/** Paper, in CSS units. The same two the PDF backend knows, said the other way. */
const PAGE_CSS: Record<DocumentPageSize, string> = {
	a4: 'A4',
	letter: 'Letter',
}

/** Base type size in points, per the theme's type scale. */
export const DOCUMENT_BASE_PT: Record<DocumentStyle['typeScale'], number> = {
	compact: 10,
	default: 11,
	relaxed: 12,
}

/** Vertical rhythm multiplier, per the theme's density. */
export const DOCUMENT_LINE_HEIGHT: Record<DocumentStyle['density'], number> = {
	comfortable: 1.45,
	compact: 1.25,
}

/**
 * Escape text for HTML.
 *
 * Applied to **every** interpolated string without exception — labels, values,
 * captions, the title. Document text is row data, and row data is whatever
 * somebody typed into a form. The one place this could have been "obviously
 * safe" is the field label, which comes from the spec rather than the database;
 * it is escaped anyway, because "this one is safe" is how the unescaped one
 * eventually gets copied.
 */
export function escapeHtml(text: string): string {
	return text
		.replace(/&/g, '&amp;')
		.replace(/</g, '&lt;')
		.replace(/>/g, '&gt;')
		.replace(/"/g, '&quot;')
		.replace(/'/g, '&#39;')
}

/** The document's stylesheet, derived entirely from the theme and the paper. */
function documentCss(style: DocumentStyle, pageSize: DocumentPageSize): string {
	const base = DOCUMENT_BASE_PT[style.typeScale]
	const line = DOCUMENT_LINE_HEIGHT[style.density]
	const gap = style.density === 'compact' ? 8 : 12
	return `
@page { size: ${PAGE_CSS[pageSize]}; margin: 18mm; }
:root {
	--doc-accent: ${style.accent};
	--doc-ink: #111111;
	--doc-muted: #555555;
	--doc-rule: #d4d4d8;
	--doc-font: ${FONT_STACKS[style.font]};
	--doc-base: ${base}pt;
	--doc-gap: ${gap}pt;
}
* { box-sizing: border-box; }
html, body { margin: 0; padding: 0; }
body {
	font-family: var(--doc-font);
	font-size: var(--doc-base);
	line-height: ${line};
	color: var(--doc-ink);
	background: #ffffff;
}
.doc { max-width: 100%; padding: 18mm; }
/* The screen padding is the print margin's stand-in; @page owns it on paper,
   so it is removed there rather than applied twice. */
@media print { .doc { padding: 0; } }
h1 {
	font-size: ${(base * 1.8).toFixed(1)}pt;
	color: var(--doc-accent);
	margin: 0 0 var(--doc-gap) 0;
	letter-spacing: -0.01em;
}
h2 {
	font-size: ${(base * 1.25).toFixed(1)}pt;
	margin: calc(var(--doc-gap) * 1.5) 0 calc(var(--doc-gap) / 2) 0;
}
p { margin: 0 0 var(--doc-gap) 0; }
hr {
	border: 0;
	border-top: 1px solid var(--doc-rule);
	margin: var(--doc-gap) 0;
}
.doc-caption {
	font-size: ${(base * 0.85).toFixed(1)}pt;
	text-transform: uppercase;
	letter-spacing: 0.06em;
	color: var(--doc-muted);
	margin: 0 0 calc(var(--doc-gap) / 2) 0;
}
.doc-pairs { display: grid; gap: calc(var(--doc-gap) / 2) var(--doc-gap); margin-bottom: var(--doc-gap); }
.doc-pairs--1 { grid-template-columns: 1fr; }
.doc-pairs--2 { grid-template-columns: 1fr 1fr; }
.doc-pair-label { color: var(--doc-muted); font-size: ${(base * 0.85).toFixed(1)}pt; }
.doc-pair-value { font-variant-numeric: tabular-nums; }
table { width: 100%; border-collapse: collapse; margin-bottom: var(--doc-gap); }
th, td { padding: calc(var(--doc-gap) / 2) 0; text-align: left; vertical-align: top; }
th {
	border-bottom: 1px solid var(--doc-accent);
	font-size: ${(base * 0.85).toFixed(1)}pt;
	text-transform: uppercase;
	letter-spacing: 0.06em;
	color: var(--doc-muted);
	font-weight: 600;
}
td { border-bottom: 1px solid var(--doc-rule); font-variant-numeric: tabular-nums; }
.doc-right { text-align: right; }
.doc-note { color: var(--doc-muted); font-size: ${(base * 0.85).toFixed(1)}pt; }
/* Rows and blocks are kept whole across a page break where the engine allows
   it; a line item split down the middle is the classic printed-table bug. */
tr, .doc-pairs { break-inside: avoid; page-break-inside: avoid; }
h1, h2 { break-after: avoid; page-break-after: avoid; }
/* Printer drivers drop backgrounds by default; the rules here are borders and
   text color for exactly that reason, and this asks for the rest anyway. */
@media print { body { -webkit-print-color-adjust: exact; print-color-adjust: exact; } }
`.trim()
}

/** One block as HTML. */
function blockHtml(block: DocumentBlock): string {
	switch (block.kind) {
		case 'heading':
			return `<h${block.level}>${escapeHtml(block.text)}</h${block.level}>`
		case 'paragraph':
			return `<p>${escapeHtml(block.text)}</p>`
		case 'rule':
			return '<hr />'
		case 'pairs': {
			const caption = block.caption
				? `<p class="doc-caption">${escapeHtml(block.caption)}</p>`
				: ''
			const pairs = block.pairs
				.map(
					(pair) =>
						`<div><div class="doc-pair-label">${escapeHtml(pair.label)}</div><div class="doc-pair-value">${escapeHtml(pair.value)}</div></div>`,
				)
				.join('')
			return `${caption}<div class="doc-pairs doc-pairs--${block.columns}">${pairs}</div>`
		}
		case 'table': {
			const caption = block.caption
				? `<p class="doc-caption">${escapeHtml(block.caption)}</p>`
				: ''
			const head = block.columns
				.map(
					(col) =>
						`<th${col.align === 'right' ? ' class="doc-right"' : ''}>${escapeHtml(col.label)}</th>`,
				)
				.join('')
			const body = block.rows
				.map(
					(row) =>
						`<tr>${row
							.map(
								(cell, i) =>
									`<td${block.columns[i]?.align === 'right' ? ' class="doc-right"' : ''}>${escapeHtml(cell)}</td>`,
							)
							.join('')}</tr>`,
				)
				.join('')
			const note = block.note
				? `<p class="doc-note">${escapeHtml(block.note)}</p>`
				: ''
			return `${caption}<table><thead><tr>${head}</tr></thead><tbody>${body}</tbody></table>${note}`
		}
	}
}

/**
 * Render a compiled layout as a standalone, print-ready HTML document.
 *
 * Pure and self-contained: the returned string has no external references of any
 * kind, so it is equally correct served over HTTP, written to object storage, or
 * attached to an email.
 */
export function documentHtml(
	layout: DocumentLayout,
	style: DocumentStyle,
	pageSize: DocumentPageSize,
): string {
	return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>${escapeHtml(layout.title)}</title>
<style>
${documentCss(style, pageSize)}
</style>
</head>
<body>
<main class="doc">
${layout.blocks.map(blockHtml).join('\n')}
</main>
</body>
</html>
`
}
