/**
 * @vitest-environment node
 *
 * No DOM in this file. The package default is `jsdom`, which costs
 * ~400ms of environment construction per file — the dominant term in this suite's
 * CPU, and the contention that starved a synchronous render past its timeout on a
 * 2-core runner. A test that never renders should not pay for a document.
 */
import { describe, expect, it } from 'vitest'
import type { Row } from './resource-types.ts'
import { buildTree, flattenTree } from './tree.ts'

const rows: Row[] = [
	{ id: '1', name: 'root', parent_id: null },
	{ id: '2', name: 'child-a', parent_id: '1' },
	{ id: '3', name: 'child-b', parent_id: '1' },
	{ id: '4', name: 'grandchild', parent_id: '2' },
]

const opts = { idField: 'id', parentField: 'parent_id' }

describe('buildTree', () => {
	it('nests rows by parent and assigns depths', () => {
		const roots = buildTree(rows, opts)
		expect(roots).toHaveLength(1)
		const root = roots[0]
		expect(root?.depth).toBe(0)
		expect(root?.children.map((c) => c.row.id)).toEqual(['2', '3'])
		expect(root?.children[0]?.depth).toBe(1)
		expect(root?.children[0]?.children[0]?.row.id).toBe('4')
		expect(root?.children[0]?.children[0]?.depth).toBe(2)
	})

	it('treats a row with a missing parent as a root', () => {
		const orphan: Row[] = [{ id: '9', name: 'orphan', parent_id: 'gone' }]
		const roots = buildTree(orphan, opts)
		expect(roots).toHaveLength(1)
		expect(roots[0]?.row.id).toBe('9')
	})

	it('does not place a self-parenting node under itself', () => {
		const selfp: Row[] = [{ id: '1', parent_id: '1' }]
		const roots = buildTree(selfp, opts)
		expect(roots).toHaveLength(1)
		expect(roots[0]?.children).toHaveLength(0)
	})
})

describe('flattenTree', () => {
	it('omits a collapsed node subtree', () => {
		const roots = buildTree(rows, opts)
		const collapsedRoot = flattenTree(roots, {
			idField: 'id',
			isExpanded: () => false,
		})
		expect(collapsedRoot.map((n) => n.row.id)).toEqual(['1'])
	})

	it('includes the full subtree when expanded', () => {
		const roots = buildTree(rows, opts)
		const all = flattenTree(roots, { idField: 'id', isExpanded: () => true })
		expect(all.map((n) => n.row.id)).toEqual(['1', '2', '4', '3'])
	})
})
