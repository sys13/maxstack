/**
 * The font this deployment bound for PDF documents, if any.
 *
 * ## Why an environment variable and not a spec op
 *
 * A bound font is a property of the **image**, not of the product. It answers
 * "which scripts can this container print", the same category of question as
 * `DATABASE_URL` and `MAXSTACK_TRUSTED_PROXY_HOPS`, and it is the operator who
 * puts the file in the image. Declaring it in the spec would mean a spec that
 * only renders correctly on a machine that happens to have the file — a spec
 * that is not portable, which is the one property the spec layer is careful to
 * keep.
 *
 * ## Loaded once, and loudly
 *
 * Parsing a 20 MB CJK face is the slowest thing that could be on a request path,
 * so it happens once per process. A file that is missing or is not a TrueType
 * font is reported **at first use with the reason**, and then the deployment
 * falls back to base-14 rather than failing every document: a Latin invoice
 * still renders, which is strictly better than a 500, and the log line says
 * exactly what to fix. An operator who mistyped a path finds out from their own
 * logs rather than from a customer.
 */

import { type BoundFont, bindFont } from '@maxstack/core'

const scope = globalThis as typeof globalThis & {
	__maxstackPdfFont?: Promise<BoundFont | undefined>
}

/** `MAXSTACK_PDF_FONT` — a path to a `.ttf` with TrueType outlines. Its bold
 * companion is `MAXSTACK_PDF_FONT_BOLD`; without one, bold text renders in the
 * regular face and the document embeds a single copy of the font. */
export function getDocumentFont(): Promise<BoundFont | undefined> {
	scope.__maxstackPdfFont ??= (async () => {
		const path = process.env.MAXSTACK_PDF_FONT?.trim()
		if (!path) return undefined
		const boldPath = process.env.MAXSTACK_PDF_FONT_BOLD?.trim()
		try {
			const { readFile } = await import('node:fs/promises')
			const { basename, extname } = await import('node:path')
			const regular = new Uint8Array(await readFile(path))
			const bold = boldPath
				? new Uint8Array(await readFile(boldPath))
				: undefined
			const font = bindFont({
				regular,
				...(bold ? { bold } : {}),
				// The file's own stem, so the `/BaseFont` in the PDF names the font the
				// operator actually bound rather than a placeholder.
				name: basename(path, extname(path)),
			})
			console.info(
				`[documents] bound ${path} for PDF rendering${boldPath ? ` (bold: ${boldPath})` : ' — bold text renders in the regular face'}. ` +
					'Non-Latin text prints correctly; the base-14 fallback is no longer used.',
			)
			return font
		} catch (error) {
			// Never fatal. A Latin document still renders through base-14, and the
			// reason is on the operator's own console rather than in a support ticket
			// about question marks.
			console.error(
				`[documents] MAXSTACK_PDF_FONT is set to "${path}" but could not be used, so PDFs fall back to the base-14 fonts — ` +
					'text outside Latin-1 will print as "?". Bind a .ttf with TrueType outlines (not .otf/CFF, not .ttc).',
				error,
			)
			return undefined
		}
	})()
	return scope.__maxstackPdfFont
}
