/**
 * Example app: blog (a minimal multi-author publishing platform).
 *
 * Grounded in the ported `blogPRD` fixture. A content-shaped domain
 * (posts, authors, comments) rather than a task board — another axis so the
 * pipeline isn't overfit to admin CRUD.
 *
 * Its backlog is op-friendly (a content tool grows new fields and views), so it
 * scores a high spec-op share. The ranked full-text search it used to carry as
 * off-surface is a `search.declare` since issue #174; what stays off-surface is
 * the *relevance* half — typo tolerance, synonyms and editor-pinned results.
 * The themed per-author public site it used
 * to carry as off-surface is a `portals.declare` since issue #177; what stays
 * off-surface there is the half a projection is not — a page whose *content* is
 * negotiated and whose edge cache has to be provably coherent.
 */

import { blogPRD } from './deps.ts'
import {
	addField,
	addPage,
	addSlot,
	crudExample,
	declarePortal,
	declareSearchIndex,
	ejectPage,
	entity,
	field,
	fillSlot,
	offSurface,
	page,
	portal,
	retitle,
	searchIndex,
	slot,
	table,
} from './kit.ts'

const entities = [
	entity('e-post', 'Post', 'A piece of writing under the shared publication.', [
		field('fld-post-title', 'title', 'string', true),
		field('fld-post-body', 'body', 'string', true),
		field('fld-post-published', 'published', 'boolean'),
	]),
	entity('e-author', 'Author', 'A contributor who writes posts.', [
		field('fld-author-name', 'name', 'string', true),
		field('fld-author-bio', 'bio', 'string'),
	]),
	entity('e-comment', 'Comment', 'A reader’s response to a post.', [
		field('fld-comment-body', 'body', 'string', true),
		field('fld-comment-approved', 'approved', 'boolean'),
	]),
]

const postsPage = page({
	id: 'pg-posts',
	name: 'Posts',
	route: '/admin/posts',
	entityId: 'e-post',
	blocks: [table('blk-posts-table'), slot('blk-posts-preview', 'draftPreview')],
	e2eTests: [
		'An author can draft a post and see it in the list',
		'Publishing a post moves it out of the draft section',
	],
})

const authorsPage = page({
	id: 'pg-authors',
	name: 'Authors',
	route: '/admin/authors',
	entityId: 'e-author',
	blocks: [
		table('blk-authors-table'),
		slot('blk-authors-actions', 'authorActions'),
	],
	e2eTests: [
		'An editor can add an author with a bio',
		'An author with no posts shows an empty byline',
	],
})

const commentsPage = page({
	id: 'pg-comments',
	name: 'Comments',
	route: '/admin/comments',
	entityId: 'e-comment',
	blocks: [table('blk-comments-table')],
	e2eTests: [
		'A moderator can approve a pending comment',
		'The empty state shows before any comments arrive',
	],
})

export const blogExample = crudExample({
	id: 'blog',
	title: 'Blog — multi-author publishing',
	prd: blogPRD,
	entities,
	pages: [postsPage, authorsPage],
	changes: [
		addField(
			'ch-post-slug',
			'Add a URL slug to posts (spec op).',
			'e-post',
			'fld-post-slug',
			'slug',
			'string',
		),
		addField(
			'ch-post-tags',
			'Add a tags field to posts for topic grouping (spec op).',
			'e-post',
			'fld-post-tags',
			'tags',
			'string',
		),
		addPage(
			'ch-add-comments',
			'Add the Comments moderation page (spec op).',
			commentsPage,
		),
		retitle(
			'ch-retitle-posts',
			'Rename Posts to “Posts & Drafts” (regeneration-as-diff).',
			'post',
			'Posts & Drafts',
		),
		fillSlot(
			'ch-draft-preview-slot',
			'Fill the draft-preview slot on the Posts page (slot fill).',
			'post',
			'draftPreview',
			[
				'// User-owned: an inline preview of the draft being edited.',
				'export function draftPreview() {',
				'\treturn <aside aria-label="draft preview">Preview</aside>',
				'}',
			].join('\n'),
		),
		addSlot(
			'ch-author-social-slot',
			'Open a social-links slot on the Authors page (spec op).',
			'pg-authors',
			'blk-authors-social',
			'authorSocial',
		),
		addField(
			'ch-author-avatar',
			'Add an avatar URL to authors (spec op).',
			'e-author',
			'fld-author-avatar',
			'avatar',
			'string',
		),
		addField(
			'ch-comment-spam',
			'Add a spam-score field to comments (spec op).',
			'e-comment',
			'fld-comment-spam',
			'spamScore',
			'number',
		),
		ejectPage(
			'ch-eject-comments',
			'Eject the Comments page for a bespoke moderation queue (eject).',
			'comment',
		),
		declareSearchIndex(
			'ch-fulltext-search',
			'Ranked full-text search across every post, title matches outranking body matches (spec op).',
			searchIndex({
				id: 'idx-post-search',
				key: 'post-search',
				description:
					'Ranked search over post titles and bodies, for the public archive.',
				entityId: 'e-post',
				language: 'english',
				fields: [
					{ fieldId: 'fld-post-title', weight: 'A' },
					{ fieldId: 'fld-post-body', weight: 'B' },
				],
				// A publishing tool reads far more than it writes, so the index earns
				// its cost here. Stating it is the point — see `declareSearchIndex`.
				indexed: true,
			}),
		),
		offSurface(
			'ch-search-relevance-tuning',
			'Typo-tolerant, synonym-aware search with editor-pinned results for chosen queries — a relevance layer keyed on the query, not on the fields (off-surface, unexpressible).',
			'post',
			'unexpressible',
			'search',
		),
		declarePortal(
			// RECLASSIFIED 2026-07-29 by issue #177, from off-surface/eject.
			// `portals.declare` is the op: a public audience over the author surface
			// with an opt-in field projection and a declared bound, themed by the
			// app's own `theme.set` rather than by an ejected layout. See
			// docs/corpus/blog-author-microsite.md.
			'ch-author-microsite',
			'A themed public micro-site per author (spec op).',
			portal({
				id: 'ptl-author-ann',
				key: 'author-ann',
				description: 'One author’s public page: who they are, in their words.',
				entityId: 'e-author',
				audience: 'public',
				scope: 'collection',
				// Opt-in per field, and note what is NOT here: nothing beyond the
				// three the author writes about themselves. There is deliberately no
				// "everything on the author row" spelling to reach for.
				readFields: ['fld-author-name', 'fld-author-bio', 'fld-author-avatar'],
				// The bound a collection portal is required to carry. This example's
				// data model has no foreign key from a post back to an author, so the
				// micro-site cannot list that author's posts — deliberately, because
				// inventing that relation to give the shipped op more surface to sit
				// on is the corpus edit `docs/corpus-integrity.md` exists to prevent.
				filter: { fieldId: 'fld-author-name', equals: 'Ann Rivers' },
				writes: [],
				layout: 'cards',
				paused: false,
			}),
		),
		offSurface(
			// CORPUS HARDENING 2026-07-29 — replaces the residual
			// difficulty the reclassification above removed, in the same product
			// area, and sourced from how publishing platforms actually serve a
			// public page rather than from this vocabulary. See
			// docs/corpus/blog-negotiated-public-page.md.
			'ch-negotiated-public-page',
			'Serve one public URL as several negotiated documents — a regional variant, a consent-tier variant with third-party embeds stripped, and a signed-in variant — cached at the edge and provably invalidated on publish, unpublish and takedown — no op models a response whose CONTENT is negotiated or a cache that must be proven coherent (off-surface, unexpressible).',
			'author',
			'unexpressible',
			'public-surface',
		),
	],
})
