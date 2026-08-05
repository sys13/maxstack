/**
 * Build a nested tree from flat rows of a self-referencing resource (Plan v5
 * task 40) — the data behind `<TreeList>`. Pure and framework-agnostic: given
 * rows, an id field, and a parent field, return roots with `children`. Rows
 * whose parent is missing (or points outside the set) become roots, so a
 * filtered/paginated slice still renders sanely. Cycle-safe: a node is never
 * placed under one of its own descendants.
 */

import type { Row } from './resource-types.ts'

export interface TreeNode {
	row: Row
	children: TreeNode[]
	depth: number
}

export interface BuildTreeOptions {
	idField: string
	/** The FK column pointing at the same table (e.g. `parent_id`). */
	parentField: string
}

export function buildTree(rows: Row[], options: BuildTreeOptions): TreeNode[] {
	const { idField, parentField } = options
	const nodes = new Map<string, TreeNode>()
	for (const row of rows) {
		nodes.set(String(row[idField]), { row, children: [], depth: 0 })
	}

	const roots: TreeNode[] = []
	for (const node of nodes.values()) {
		const parentId = node.row[parentField]
		const parent = parentId == null ? undefined : nodes.get(String(parentId))
		// A node parenting itself, or pointing at a missing/out-of-slice parent,
		// is treated as a root.
		if (parent && parent !== node) parent.children.push(node)
		else roots.push(node)
	}

	// Assign depths + guard against cycles (a node reachable from itself is cut
	// loose to a root the first time we'd revisit it).
	const seen = new Set<TreeNode>()
	const assign = (node: TreeNode, depth: number): void => {
		if (seen.has(node)) {
			node.children = []
			return
		}
		seen.add(node)
		node.depth = depth
		for (const child of node.children) assign(child, depth + 1)
	}
	for (const root of roots) assign(root, 0)

	return roots
}

/** Flatten a tree to a pre-order list, honoring a per-id expansion set: a
 * collapsed node's subtree is omitted. Used to render the tree as table rows. */
export function flattenTree(
	roots: TreeNode[],
	options: { idField: string; isExpanded: (id: string) => boolean },
): TreeNode[] {
	const { idField, isExpanded } = options
	const out: TreeNode[] = []
	const walk = (node: TreeNode): void => {
		out.push(node)
		if (node.children.length > 0 && isExpanded(String(node.row[idField]))) {
			for (const child of node.children) walk(child)
		}
	}
	for (const root of roots) walk(root)
	return out
}
