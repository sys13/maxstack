/**
 * @vitest-environment node
 *
 * No DOM in this file. The package default is `jsdom`, which costs
 * ~400ms of environment construction per file — the dominant term in this suite's
 * CPU, and the contention that starved a synchronous render past its timeout on a
 * 2-core runner. A test that never renders should not pay for a document.
 */
import { describe, expect, it } from 'vitest'
import { renderMarkdown } from './markdown.ts'

describe('renderMarkdown', () => {
	it('renders headings, emphasis, code, and links', () => {
		expect(renderMarkdown('# Title')).toContain('<h1>Title</h1>')
		expect(renderMarkdown('**b**')).toContain('<strong>b</strong>')
		expect(renderMarkdown('*i*')).toContain('<em>i</em>')
		expect(renderMarkdown('`c`')).toContain('<code>c</code>')
		expect(renderMarkdown('[x](https://example.com)')).toContain(
			'<a href="https://example.com"',
		)
	})

	it('escapes HTML before applying any rule (XSS-safe)', () => {
		const out = renderMarkdown('<script>alert(1)</script>')
		expect(out).not.toContain('<script>')
		expect(out).toContain('&lt;script&gt;')
	})

	it('turns blank lines into paragraph breaks', () => {
		expect(renderMarkdown('a\n\nb')).toBe('a<br/><br/>b')
	})
})
