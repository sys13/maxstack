import {
	newSpecSystem,
	type PageSpec,
	type SpecSystem,
	suggested,
} from '@maxstack/spec'
import { tasklyPRD } from '@maxstack/spec/fixtures'
import { describe, expect, it } from 'vitest'
import { adminProjectMatchApplies, matchAdminPath } from './admin-routes'
import { matchProjectPath } from './project-routes'

function specWith(pages: PageSpec[]): SpecSystem {
	const spec = newSpecSystem(tasklyPRD)
	return { ...spec, pages: { pages } }
}

const posts: PageSpec = {
	id: 'pg-posts',
	name: 'Posts',
	route: '/admin/posts',
	entityId: 'e-post',
	provenance: suggested(),
	blocks: [{ id: 'blk-table', type: 'table', provenance: suggested() }],
}

describe('matchAdminPath', () => {
	it('reads one segment as the resource list', () => {
		expect(matchAdminPath('post')).toEqual({ kind: 'list', resource: 'post' })
	})

	it('reads the create form and the trash can by name', () => {
		expect(matchAdminPath('post/new')).toEqual({
			kind: 'new',
			resource: 'post',
		})
		expect(matchAdminPath('post/trash')).toEqual({
			kind: 'trash',
			resource: 'post',
		})
	})

	it('reads the describe-to-prefill endpoint by name', () => {
		// Shadows a record whose id is literally `parse`, on the same terms `new`
		// and `trash` already do — and it is POST-only, so what it shadows was
		// only ever reachable as a page.
		expect(matchAdminPath('post/parse')).toEqual({
			kind: 'parse',
			resource: 'post',
		})
	})

	it('reads anything else in the trailing position as a record id', () => {
		expect(matchAdminPath('post/42')).toEqual({
			kind: 'edit',
			resource: 'post',
			id: '42',
		})
	})

	it('decodes a percent-encoded record id', () => {
		expect(matchAdminPath('post/a%2Fb')).toEqual({
			kind: 'edit',
			resource: 'post',
			id: 'a/b',
		})
	})

	it('tolerates a trailing slash and an empty remainder', () => {
		expect(matchAdminPath('post/')).toEqual({ kind: 'list', resource: 'post' })
		expect(matchAdminPath('')).toBeUndefined()
	})

	it('has no surface deeper than two segments', () => {
		expect(matchAdminPath('post/42/edit')).toBeUndefined()
	})
})

describe('a spec page declared under /admin', () => {
	const spec = specWith([posts])

	it('owns its declared route, which the generic admin would have read as a resource', () => {
		// The defect: `/admin/posts` matched `:resource` as `posts`, the registry
		// holds `post`, and the page its own spec declared 404'd.
		expect(matchProjectPath(spec, '/admin/posts')).toMatchObject({
			kind: 'list',
			page: { slug: 'admin/posts' },
		})
		expect(matchAdminPath('posts')).toEqual({ kind: 'list', resource: 'posts' })
	})

	it('owns its create form, which collided with `:resource/:id`', () => {
		expect(matchProjectPath(spec, '/admin/posts/new')).toMatchObject({
			kind: 'new',
			page: { slug: 'admin/posts' },
		})
	})

	it('owns its records', () => {
		expect(matchProjectPath(spec, '/admin/posts/42')).toMatchObject({
			kind: 'edit',
			page: { slug: 'admin/posts' },
			id: '42',
		})
	})

	it('leaves an undeclared path to the generic admin', () => {
		expect(matchProjectPath(spec, '/admin/post')).toBeUndefined()
		expect(matchProjectPath(spec, '/admin/post/42')).toBeUndefined()
	})
})

describe('adminProjectMatchApplies', () => {
	const admin: PageSpec = { ...posts, id: 'pg-admin', route: '/admin' }

	it('honours a page declared below /admin', () => {
		const match = matchProjectPath(specWith([posts]), '/admin/posts')
		expect(match && adminProjectMatchApplies(match)).toBe(true)
	})

	it('refuses to let a page declared *at* /admin claim the whole namespace', () => {
		// `/admin` is a static route, so that page's own list is unreachable
		// anyway. Honouring its record interpretation would make `/admin/post`
		// mean "record `post` of the page called admin" and take the generic
		// admin down with it.
		const match = matchProjectPath(specWith([admin]), '/admin/post')
		expect(match).toMatchObject({ kind: 'edit', id: 'post' })
		expect(match && adminProjectMatchApplies(match)).toBe(false)
	})
})
