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

import { getAcceptedOrAll, type OpActor, type SpecOp } from '@maxstack/spec'
import { entityChoices } from '../lib/choices.ts'
import {
	buildEntity,
	buildPage,
	parseField,
	slugProblem,
	titleCase,
} from '../lib/field-dsl.ts'
import { promptField, promptFields } from '../lib/field-prompt.ts'
import { landOp, landOps, landSummary } from '../lib/land.ts'
import { type OpOrigin, resolveActor, resolveOrigin } from '../lib/origin.ts'
import { loadProject, type Project } from '../lib/project.ts'
import {
	echoInvocation,
	type Interaction,
	nonInteractive,
	resolveArg,
	shellQuote,
} from '../lib/prompt.ts'

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

/**
 * Resolve the entity argument `add-field` and `add-page` share: what was typed,
 * or a pick from the entities the spec already holds.
 *
 * Refuses early and clearly on an empty spec. `resolveArg` would otherwise
 * reach a zero-length menu, and "nothing to choose from" is a true statement
 * that answers the wrong question — the user's actual problem is that they have
 * no entities yet, and the fix is the command that makes one.
 */
async function pickEntitySlug(
	project: Project,
	given: string | undefined,
	io: Interaction,
): Promise<string> {
	if (given !== undefined) return given
	const choices = entityChoices(await project.spec.load())
	if (io.prompter && choices.length === 0) {
		throw new Error(
			'this project has no entities yet — run "maxstack add-entity" first.',
		)
	}
	return await resolveArg(given, 'entity', io, (prompter) =>
		prompter.select('Which entity?', choices).then((entity) => entity.id),
	)
}

export async function addEntityCommand(
	dir: string | undefined,
	slug: string | undefined,
	opts: EntitySugarOptions,
	io: Interaction = nonInteractive,
): Promise<void> {
	const project = await loadProject(dir ?? '.')
	const spec = await project.spec.load()

	const resolvedSlug = await resolveArg(slug, 'slug', io, (prompter) =>
		prompter.text('Entity name?', {
			validate: (answer) => slugProblem('entity slug', answer),
		}),
	)

	// `--field` is an option, not an argument, so commander never guarded it and
	// the empty case has always been this command's own error. Interactively it
	// becomes the field-by-field builder instead — the one prompt here that is
	// more than menu convenience, because the DSL it replaces is the part of the
	// CLI a shell can silently corrupt (see `field-prompt.ts`).
	let fields = opts.field ?? []
	if (fields.length === 0) {
		if (!io.prompter) {
			throw new Error(
				'add-entity needs at least one --field (e.g. --field title:text!)',
			)
		}
		fields = await promptFields(
			io.prompter,
			getAcceptedOrAll(spec.data.entities),
		)
		echoInvocation([
			'maxstack',
			'add-entity',
			resolvedSlug,
			...fields.flatMap((f) => ['--field', shellQuote(f)]),
		])
	}

	const settled = settle(project.config, opts, 'cli-add-entity')
	// The DSL stamps provenance explicitly, so the author has to reach the
	// builders too — not just the op-log entry.
	const entity = buildEntity(
		resolvedSlug,
		opts.name ?? titleCase(resolvedSlug),
		fields,
		settled.origin,
	)
	const entityOp: SpecOp = { op: 'data.addEntity', args: { entity } }

	// `--with-page` collapses the near-universal two-step (add-entity → add-page)
	// into one land: the page compiles to a page.addPage that references the
	// entity we just added, so the whole batch lands + accepts + gens once.
	if (opts.withPage) {
		const page = buildPage(
			resolvedSlug,
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
			`↳ no page yet — run: maxstack add-page ${resolvedSlug} (or --with-page)`,
		)
	}
}

export async function addPageCommand(
	dir: string | undefined,
	entitySlug: string | undefined,
	opts: PageSugarOptions,
	io: Interaction = nonInteractive,
): Promise<void> {
	const project = await loadProject(dir ?? '.')
	const chosen = await pickEntitySlug(project, entitySlug, io)
	// Accept either the bare slug or the full `e-` id, like `add-field`.
	const slug = chosen.startsWith('e-') ? chosen.slice(2) : chosen
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
	entitySlug: string | undefined,
	fieldSpec: string | undefined,
	opts: SugarOptions,
	io: Interaction = nonInteractive,
): Promise<void> {
	const project = await loadProject(dir ?? '.')
	const chosen = await pickEntitySlug(project, entitySlug, io)
	// The entity id is `e-<slug>`; accept either the bare slug or the full id.
	const slug = chosen.startsWith('e-') ? chosen.slice(2) : chosen
	const entityId = `e-${slug}` as const

	const resolvedSpec = await resolveArg(fieldSpec, 'spec', io, async (p) => {
		const built = await promptField(
			p,
			getAcceptedOrAll((await project.spec.load()).data.entities),
		)
		echoInvocation(['maxstack', 'add-field', slug, shellQuote(built)])
		return built
	})

	const settled = settle(project.config, opts, 'cli-add-field')
	const field = parseField(slug, resolvedSpec, settled.origin)
	const op: SpecOp = { op: 'data.addField', args: { entityId, field } }
	const result = await landOp(project, op, settled)

	console.log(`✔ added field "${field.name}" to "${entityId}"`)
	console.log(landSummary(result))
}
