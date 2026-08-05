/**
 * Minimal, dependency-free, XSS-safe markdown → HTML. Escape everything first,
 * then apply a small set of inline/heading/emphasis rules over the escaped text.
 * A full CommonMark renderer is out of scope for the library layer — this covers
 * the common admin case (bold, italic, code, links, headings) without pulling a
 * parser into the bundle, and never injects raw HTML.
 *
 * Shared by `<MarkdownField>` (read side, task 31) and `<FormMarkdownEditor>`
 * (write side, task 39) so the editor's live preview matches the rendered field
 * by construction.
 */
export function renderMarkdown(src: string): string {
	const escaped = src
		.replace(/&/g, '&amp;')
		.replace(/</g, '&lt;')
		.replace(/>/g, '&gt;')
	return escaped
		.replace(/^###\s+(.*)$/gm, '<h3>$1</h3>')
		.replace(/^##\s+(.*)$/gm, '<h2>$1</h2>')
		.replace(/^#\s+(.*)$/gm, '<h1>$1</h1>')
		.replace(/`([^`]+)`/g, '<code>$1</code>')
		.replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
		.replace(/\*([^*]+)\*/g, '<em>$1</em>')
		.replace(
			/\[([^\]]+)\]\((https?:\/\/[^\s)]+)\)/g,
			'<a href="$2" target="_blank" rel="noreferrer noopener">$1</a>',
		)
		.replace(/\n{2,}/g, '<br/><br/>')
		.replace(/\n/g, '<br/>')
}
