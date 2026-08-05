import {
	emitResourcePage,
	emitUserSlotStub,
	type PageDescriptor,
} from '@maxstack/core/ownership'
import { describe, expect, it } from 'vitest'
import { renderGeneratedPage } from './preview.server'

const descriptor: PageDescriptor = {
	resource: 'story',
	title: 'Stories',
	routePath: '/stories',
	slots: ['actions'],
}

/** The exact artifact shapes the `page` generator returns. */
function artifacts(slotContent?: string) {
	return [
		{ path: 'routes/story.tsx', content: emitResourcePage(descriptor) },
		{
			path: 'routes/story.slots.tsx',
			content: slotContent ?? emitUserSlotStub(descriptor),
		},
		{ path: 'routes.ts', content: 'export const routes = []\n' },
	]
}

describe('renderGeneratedPage — the generated app, actually rendered', () => {
	it('evaluates the emitted route module and renders its HTML', () => {
		const { html, error } = renderGeneratedPage(artifacts())
		expect(error).toBeNull()
		expect(html).toContain('<h1>Stories</h1>')
		expect(html).toContain('data-resource="story"')
	})

	it('composes the user slot file through the real <Slot> runtime', () => {
		const filled = [
			'export function actions() {',
			"\treturn 'BULK-ARCHIVE'",
			'}',
			'',
		].join('\n')
		const { html, error } = renderGeneratedPage(artifacts(filled))
		expect(error).toBeNull()
		expect(html).toContain('BULK-ARCHIVE')
	})

	it('an unfilled slot stub renders nothing (page valid before user edits)', () => {
		const { html } = renderGeneratedPage(artifacts())
		expect(html).not.toContain('BULK')
	})

	it('degrades to an error message instead of throwing', () => {
		const broken = [
			{ path: 'routes/story.tsx', content: 'export default nonsense(' },
		]
		const { html, error } = renderGeneratedPage(broken)
		expect(html).toBeNull()
		expect(error).toBeTruthy()
	})

	it('reports a missing route module', () => {
		expect(renderGeneratedPage([]).error).toMatch(/No generated route module/)
	})
})
