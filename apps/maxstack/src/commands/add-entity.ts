/**
 * `maxstack add-entity <slug> --field name:type[!] ...` and
 * `maxstack add-field <entitySlug> <name:type[!]>` — the terminal-native sugar
 * over the raw op JSON. Both compile to the exact same
 * `data.addEntity` / `data.addField` ops `maxstack op` would apply; the JSON
 * stays the honest underlying primitive.
 *
 * Like `op`, they honor `--accept`/`--gen` (and `reviewMode: "auto"`), so
 * `maxstack add-entity task --field title:text! --accept --gen` is the whole
 * happy path in one line.
 */

import type { OpActor, SpecOp } from '@maxstack/spec'
import {
	buildEntity,
	buildPage,
	parseField,
	titleCase,
} from '../lib/field-dsl.ts'
import { landOp, landOps, landSummary } from '../lib/land.ts'
import { type OpOrigin, resolveActor, resolveOrigin } from '../lib/origin.ts'
import { loadProject } from '../lib/project.ts'

interface SugarOptions {
	field?: string[]
	name?: string
	accept?: boolean
	gen?: boolean
	/** `--origin ai|human`; unset means "detect". */
	origin?: string
	/** `--agent <name>`; unset means "detect, else absent". */
	agent?: string
}

interface PageSugarOptions extends SugarOptions {
	route?: string
	id?: string
}

interface EntitySugarOptions extends SugarOptions {
	/** Also land a default list page for the entity in the same shot. */
	withPage?: boolean
	/** Route for the `--with-page` page (passthrough to `add-page`). */
	route?: string
	/** Id for the `--with-page` page (passthrough to `add-page`). */
	pageId?: string
	/** Display name for the `--with-page` page (default: the entity name). */
	pageName?: string
}

/** Normalize a `--route` value the way `add-page` does (leading slash). */
function normRoute(route: string | undefined): string | undefined {
	if (!route) return undefined
	return route.startsWith('/') ? route : `/${route}`
}

/** Normalize a `--page-id` value the way `add-page` does (`pg-` prefix). */
function normPageId(id: string | undefined): string | undefined {
	if (!id) return undefined
	return id.startsWith('pg-') ? id : `pg-${id}`
}

/**
 * Resolve accept/gen from the flags, defaulting to the project's reviewMode,
 * plus the op's author (`--origin`, else detected) and which author
 * (`resolveActor`).
 *
 * `path` is the caller's write-path id rather than one shared value: three verbs
 * come through here, and a trail that recorded all of them as "the sugar
 * commands" would be a trail a reviewer has to guess at.
 */
function settle(
	config: { reviewMode: 'review' | 'auto' },
	opts: SugarOptions,
	path: string,
): { accept: boolean; gen: boolean; origin: OpOrigin; actor: OpActor } {
	const auto = config.reviewMode === 'auto'
	return {
		accept: opts.accept ?? auto,
		gen: opts.gen ?? auto,
		origin: resolveOrigin(opts.origin),
		actor: resolveActor({ path, agent: opts.agent }),
	}
}

export async function addEntityCommand(
	dir: string | undefined,
	slug: string,
	opts: EntitySugarOptions,
): Promise<void> {
	const fields = opts.field ?? []
	if (fields.length === 0) {
		throw new Error(
			'add-entity needs at least one --field (e.g. --field title:text!)',
		)
	}
	const project = await loadProject(dir ?? '.')
	const settled = settle(project.config, opts, 'cli-add-entity')
	// The DSL stamps provenance explicitly, so the author has to reach the
	// builders too — not just the op-log entry.
	const entity = buildEntity(
		slug,
		opts.name ?? titleCase(slug),
		fields,
		settled.origin,
	)
	const entityOp: SpecOp = { op: 'data.addEntity', args: { entity } }

	// `--with-page` collapses the near-universal two-step (add-entity → add-page)
	// into one land: the page compiles to a page.addPage that references the
	// entity we just added, so the whole batch lands + accepts + gens once.
	if (opts.withPage) {
		const page = buildPage(
			slug,
			{
				name: opts.pageName,
				route: normRoute(opts.route),
				id: normPageId(opts.pageId),
			},
			settled.origin,
		)
		const pageOp: SpecOp = { op: 'page.addPage', args: { page } }
		const result = await landOps(project, [entityOp, pageOp], settled)
		console.log(
			`✔ added entity "${entity.id}" (${entity.fields.length} field${entity.fields.length === 1 ? '' : 's'})` +
				` + page "${page.id}" at ${page.route}`,
		)
		console.log(landSummary(result))
		return
	}

	const result = await landOp(project, entityOp, settled)

	console.log(
		`✔ added entity "${entity.id}" (${entity.fields.length} field${entity.fields.length === 1 ? '' : 's'})`,
	)
	console.log(landSummary(result))
	// The "now what?" nudge: an entity with no page is not browsable yet.
	const hasPage = result.spec.pages.pages.some((p) => p.entityId === entity.id)
	if (!hasPage) {
		console.log(
			`↳ no page yet — run: maxstack add-page ${slug} (or --with-page)`,
		)
	}
}

export async function addPageCommand(
	dir: string | undefined,
	entitySlug: string,
	opts: PageSugarOptions,
): Promise<void> {
	// Accept either the bare slug or the full `e-` id, like `add-field`.
	const slug = entitySlug.startsWith('e-') ? entitySlug.slice(2) : entitySlug
	// Friendly normalization so `--route today` and `--id today` also work.
	const route = opts.route
		? opts.route.startsWith('/')
			? opts.route
			: `/${opts.route}`
		: undefined
	const id = opts.id
		? opts.id.startsWith('pg-')
			? opts.id
			: `pg-${opts.id}`
		: undefined
	const project = await loadProject(dir ?? '.')
	const settled = settle(project.config, opts, 'cli-add-page')
	const page = buildPage(slug, { name: opts.name, route, id }, settled.origin)
	const op: SpecOp = { op: 'page.addPage', args: { page } }
	const result = await landOp(project, op, settled)

	console.log(
		`✔ added page "${page.id}" at ${page.route} (entity "${page.entityId}")`,
	)
	console.log(landSummary(result))
}

export async function addFieldCommand(
	dir: string | undefined,
	entitySlug: string,
	fieldSpec: string,
	opts: SugarOptions,
): Promise<void> {
	// The entity id is `e-<slug>`; accept either the bare slug or the full id.
	const slug = entitySlug.startsWith('e-') ? entitySlug.slice(2) : entitySlug
	const entityId = `e-${slug}` as const
	const project = await loadProject(dir ?? '.')
	const settled = settle(project.config, opts, 'cli-add-field')
	const field = parseField(slug, fieldSpec, settled.origin)
	const op: SpecOp = { op: 'data.addField', args: { entityId, field } }
	const result = await landOp(project, op, settled)

	console.log(`✔ added field "${field.name}" to "${entityId}"`)
	console.log(landSummary(result))
}
