/**
 * @vitest-environment node
 *
 * No DOM in this file. The package default is `jsdom`, which costs
 * ~400ms of environment construction per file — the dominant term in this suite's
 * CPU, and the contention that starved a synchronous render past its timeout on a
 * 2-core runner. A test that never renders should not pay for a document.
 */
import { describe, expect, it } from 'vitest'
import {
	breadcrumbsFor,
	createResourceRegistry,
	resourceBasePath,
} from './resource-registry.ts'

function sample() {
	return createResourceRegistry([
		{ name: 'post', icon: '📝' },
		{ name: 'comment', requires: 'read' },
		{ name: 'auditLog', views: { list: true, create: false, edit: false } },
	])
}

describe('createResourceRegistry', () => {
	it('resolves defaults: label, plural, views all on', () => {
		const r = sample().get('auditLog')
		expect(r?.label).toBe('Audit Log')
		expect(r?.pluralLabel).toBe('Audit Logs')
		expect(r?.views.list).toBe(true)
		expect(r?.views.create).toBe(false)
	})

	it('menu lists resources with list views in registration order', () => {
		const entries = sample().menu()
		expect(entries.map((e) => e.name)).toEqual(['post', 'comment', 'auditLog'])
		expect(entries[0]?.href).toBe('/post')
		expect(entries[0]?.icon).toBe('📝')
	})

	it('hides a menu entry the session cannot read', () => {
		const entries = sample().menu({
			comment: { read: false, create: false, update: false, delete: false },
		})
		expect(entries.map((e) => e.name)).toEqual(['post', 'auditLog'])
	})

	it('derives routes per declared view', () => {
		const routes = sample().routes()
		const audit = routes.filter((r) => r.name === 'auditLog')
		expect(audit.map((r) => `${r.kind}:${r.path}`)).toEqual([
			'list:/auditLog',
			'show:/auditLog/:id',
		])
		const post = routes.filter((r) => r.name === 'post')
		expect(post.map((r) => r.kind)).toEqual(['list', 'create', 'show', 'edit'])
	})

	it('respects an explicit order', () => {
		const r = createResourceRegistry([
			{ name: 'b', order: 1 },
			{ name: 'a', order: 0 },
		])
		expect(r.all().map((x) => x.name)).toEqual(['a', 'b'])
	})

	it('resourceBasePath', () => {
		expect(resourceBasePath('post')).toBe('/post')
	})
})

describe('breadcrumbsFor', () => {
	it('builds a list trail (Home / Posts)', () => {
		const crumbs = breadcrumbsFor(sample(), 'post', { kind: 'list' })
		expect(crumbs.map((c) => c.label)).toEqual(['Home', 'Posts'])
		expect(crumbs[1]?.href).toBeUndefined() // current page, not a link
	})

	it('builds an edit trail (Home / Posts / id / Edit)', () => {
		const crumbs = breadcrumbsFor(sample(), 'post', { kind: 'edit', id: '42' })
		expect(crumbs.map((c) => c.label)).toEqual(['Home', 'Posts', '42', 'Edit'])
		expect(crumbs[1]?.href).toBe('/post')
		expect(crumbs[2]?.href).toBe('/post/42')
	})

	it('omits home when passed null', () => {
		const crumbs = breadcrumbsFor(sample(), 'post', {
			kind: 'create',
			home: null,
		})
		expect(crumbs.map((c) => c.label)).toEqual(['Posts', 'New'])
	})
})
