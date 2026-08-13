/**
 * MCP tool generation + execution over registered resources.
 * See the reference design.
 *
 * ## The vocabulary is fixed-size, and the resource is an argument
 *
 * This used to emit five to seven tools *per resource*, each `create_`/`update_`
 * carrying its whole per-field JSON schema inline. That is O(entities) with a
 * large constant, broadcast to every client on connect before the agent has
 * asked for anything: 110 tools / 49KB at 22 entities, **670 tools / 299KB at
 * 134** — ~2.8× the payload Claude Code already refuses in #313. It failed
 * silently, because a client that truncates a tool list does not report which
 * tools it dropped.
 *
 * The shape now is a small fixed set — `describe_resources`, `list_records`,
 * `get_record`, `search_records`, `create_record`, `update_record`,
 * `delete_record`, `plan_import`, `render_document`, `portal_exposure_report` —
 * that takes the subject as an argument, with **schemas fetched on demand
 * instead of broadcast on connect**. At most ten tools, at any entity count.
 *
 * Pagination was the obvious alternative and is the wrong answer, for #303's
 * reason: 670 tools is not a payload that wants compressing, it is 670 tools
 * answering single-entity questions when an agent's questions span entities.
 * Paging the list would have kept every one of them and merely made discovery
 * multi-round-trip. Parameterizing the subject is the same move #303 asks for on
 * reads — a `resource` argument is where its declared-reference traversals will
 * later hang, without adding a tool.
 *
 * ### What is preserved
 *
 * - **Capability.** Every verb an agent had, it still has; the resource moved
 *   from the tool's name into its arguments. The old per-resource names remain
 *   *executable* (see {@link executeMCPTool}) so a session or transcript holding
 *   one is not broken — they are simply no longer advertised.
 * - **Row-less gating.** A verb is offered when *some* reachable resource
 *   permits it, and `describe_resources` lists only resources the caller may
 *   touch and only the actions it may perform — computed with the same
 *   `canPerformAction` the old per-tool gate used, with no row fetched. It is
 *   not an enumeration of what the caller cannot read. `executeMCPTool` still
 *   re-authorizes server-side with the fetched row — that is the real gate.
 * - **The three deliberate omissions below.** A generic mutate tool does not
 *   reopen them: `plan_import` still plans and never applies, there is still no
 *   portal-token mint, and there is still no live subscribe.
 * - **One read path.** Every generic tool dispatches into the same `opList`/
 *   `opGet`/`opSearch`/`opCreate`/`opUpdate`/`opDelete` the named ones did.
 *
 * ## Imports are dry-run only over MCP
 *
 * A declared importer gets a `plan_import_<key>` tool and **no apply tool**, and
 * the omission is deliberate rather than unfinished.
 *
 * `opApplyImport` takes an `ImportPlan` and nothing else, which is what makes the
 * dry-run structural instead of a policy. Over a wire protocol that guarantee has
 * nowhere to live: an `apply_import` tool would have to accept a plan *the client
 * sent back*, and a client-supplied plan is a client-supplied list of writes —
 * ids to overwrite and values to write into them, with the platform's own
 * validation already stamped on it. The gate would be reduced to trusting the
 * caller to return the plan it was given.
 *
 * So an agent can read a file, see exactly what would change, and report it; a
 * person confirms the apply on the surface that still holds the plan it built
 * (`/imports/:key`). That is not a limitation of MCP, it is the review-first
 * posture of the rest of the platform arriving at the one op that can destroy
 * data. When an agent *does* apply an import through that surface, the resulting
 * writes are attributed like any other agent write — `opCreate`/`opUpdate` stamp
 * `origin` and `apiKeyId` from the context, because the import path has no other
 * way to write.
 *
 * ## Portals are reportable and never mintable
 *
 * There is one portal tool, `portal_exposure_report`, and it is read-only. An
 * agent driving this vocabulary can declare a portal (through the spec ops) and
 * can *audit* what every declared portal exposes — which is the half that makes
 * the declaration reviewable.
 *
 * **There is deliberately no tool that mints a portal token, and there never
 * will be one here.** A minted token is a bearer credential in plaintext,
 * returned exactly once; putting one on the wire to an agent means it lands in a
 * transcript, a log and a context window, and none of those can be revoked. The
 * mint path is a person on a server-rendered surface with an audit entry
 * attached. That is not a gap in the exit criteria, it is the same review-first
 * posture `imports` applies to its apply step, arriving at the one operation
 * that hands somebody a key.
 *
 * ## Live channels are declarable and never streamable
 *
 * There is **no live tool here at all** — no subscribe, no poll, no "what
 * changed since". An agent driving this vocabulary can declare, retune, pause
 * and remove a channel through the `live.*` spec ops, which is the half that is
 * reviewable; what it cannot do is hold one open.
 *
 * That is a consequence rather than a gap. A subscription is a long-lived
 * connection whose whole guarantee is that **every message is re-authorized for
 * the identity that is still on the other end** — and over a request/response
 * tool protocol there is no other end to re-authorize. An MCP "subscribe" tool
 * would have to be a poll wearing a stream's name, and the honest spelling of a
 * poll is `list_<table>`, which already exists, already goes through `opList`,
 * and already carries every scope a live message would.
 *
 * The one shape that would be genuinely new is "give me everything that changed
 * since token X", and that is a change-feed with its own retention, ordering and
 * compaction semantics — a real design, and not this one. Adding a thin version
 * of it here would put an agent's view of the data on a different read path from
 * everybody else's, which is the drift `opSearch` and `opRenderDocument` were
 * both arranged to avoid.
 */

import { ConflictError, ConstraintViolationError } from './constraints.ts'
import type { ErrorContext } from './error-id.ts'
import { nextErrorId, reportInternalError } from './error-id.ts'
import type { ImportPlan } from './imports.ts'
import {
	EmptyUpdateError,
	InvalidActionChoiceError,
	LimitExceededError,
	NotFoundError,
	type OpContext,
	opCreate,
	opDelete,
	opGet,
	opList,
	opRenderDocument,
	opRunAction,
	opSearch,
	opUpdate,
	planImport,
	RateLimitedError,
	SelectionTooLargeError,
	UnknownActionError,
	UnknownResourceError,
	UnsupportedOperationError,
	ValidationError,
} from './operations.ts'
import {
	canPerformAction,
	createAccessContext,
	PermissionError,
	type SproutAction,
	type SproutUser,
} from './permissions.ts'
import { opQuery, parseQuerySpec, QUERY_LIMITS, queryEdges } from './query.ts'
import type { RegisteredResource, ResourceRegistry } from './registry.ts'
import type { SproutColumn } from './types.ts'

export interface JsonSchema {
	type: 'object'
	properties: Record<string, Record<string, unknown>>
	required?: string[]
}

export interface McpTool {
	name: string
	description: string
	inputSchema: JsonSchema
}

export interface McpToolResult {
	content: { type: 'text'; text: string }[]
	isError?: boolean
}

const TIMESTAMP_NAMES = new Set([
	'createdAt',
	'updatedAt',
	'created_at',
	'updated_at',
])

function jsonType(column: SproutColumn): Record<string, unknown> {
	const base: Record<string, unknown> = {}
	if (column.meta.description ?? column.meta.label) {
		base.description = column.meta.description ?? column.meta.label
	}
	switch (column.type) {
		case 'number':
			return { ...base, type: 'number' }
		case 'boolean':
			return { ...base, type: 'boolean' }
		case 'json':
			return { ...base, type: 'object' }
		case 'date':
			return { ...base, type: 'string', format: 'date-time' }
		case 'enum':
			return { ...base, type: 'string', enum: column.enumValues ?? [] }
		default: {
			if (column.references) {
				base.description = `Foreign key to ${column.references.table}`
			}
			// A declared file field. The value is a storage key an
			// upload produced — an agent writing this column has to know that it
			// cannot invent one, and what the field would have accepted.
			if (column.meta.isFile === true) {
				const limits = [
					column.meta.fileAccept ? `accepts ${column.meta.fileAccept}` : '',
					column.meta.fileMaxSize ? `max ${column.meta.fileMaxSize} bytes` : '',
				].filter(Boolean)
				base.description = [
					'Storage key from POST /api/upload — not a URL, and not inventable',
					limits.length ? `(${limits.join('; ')})` : '',
					(column.meta.fileDerivatives ?? []).length
						? `derivatives: ${(column.meta.fileDerivatives ?? []).map((d) => d.name).join(', ')}`
						: '',
				]
					.filter(Boolean)
					.join('. ')
			}
			return { ...base, type: 'string' }
		}
	}
}

function fieldColumns(
	entry: RegisteredResource,
	mode: 'create' | 'update',
): SproutColumn[] {
	return entry.resource.columns.filter((c) => {
		if (c.isPrimaryKey) return false
		if (TIMESTAMP_NAMES.has(c.name) && c.hasDefault) return false
		// In create mode, columns with a DB default are optional inputs.
		if (mode === 'create' && c.hasDefault) return false
		return true
	})
}

export function generateInputSchema(
	entry: RegisteredResource,
	mode: 'create' | 'update',
): JsonSchema {
	const properties: Record<string, Record<string, unknown>> = {}
	const required: string[] = []
	for (const column of fieldColumns(entry, mode)) {
		properties[column.name] = jsonType(column)
		if (mode === 'create' && !column.nullable) required.push(column.name)
	}
	const schema: JsonSchema = { type: 'object', properties }
	if (required.length > 0) schema.required = required
	return schema
}

/**
 * The `resource` argument every data tool takes.
 *
 * Deliberately **not** an enum of the registry's resource names: an enum is
 * O(entities) inside a fixed tool list, which is the same growth with a smaller
 * constant, and it would be repeated on all six data tools. `describe_resources`
 * is the one place the names live, fetched when the agent needs them.
 */
const RESOURCE_PROP: Record<string, unknown> = {
	type: 'string',
	description:
		'Resource name, exactly as `describe_resources` reports it. Call `describe_resources` first — names are discovered, not advertised here.',
}

const LIMIT_PROPS: Record<string, Record<string, unknown>> = {
	limit: { type: 'number', description: 'Max rows (default 50)' },
	offset: { type: 'number', description: 'Rows to skip (default 0)' },
}

const LIST_SCHEMA: JsonSchema = {
	type: 'object',
	properties: { resource: RESOURCE_PROP, ...LIMIT_PROPS },
	required: ['resource'],
}

/**
 * `describe_resources` — the discovery tool the fixed vocabulary needs.
 *
 * Two forms, one tool. With no `resource`: the index — every resource this
 * caller may touch, with the actions it may perform and what else is declared on
 * it (a search index, documents, importers). With a `resource`: that one
 * resource in full, including the create/update field schemas that used to be
 * inlined into `tools/list` for all 134 entities at once.
 *
 * The index is paged (`limit`/`offset`, default 100) — not because the fix to
 * #320 is pagination, but because an unbounded result is how the tool list got
 * here, and a discovery response should not repeat it.
 */
const DESCRIBE_SCHEMA: JsonSchema = {
	type: 'object',
	properties: {
		resource: {
			type: 'string',
			description:
				'Describe one resource in full: its fields, its create and update argument schemas, and its declared search index, documents and importers. Omit to get the index of every resource you may touch.',
		},
		limit: {
			type: 'number',
			description: 'Index form only: max resources (default 100).',
		},
		offset: {
			type: 'number',
			description: 'Index form only: resources to skip (default 0).',
		},
	},
}
/**
 * The `search_records` tool's arguments (reshaped by #320).
 *
 * Offered only when *something* in this registry declares an index, and
 * `describe_resources` reports per resource whether search is available there.
 * The original reasoning survives the reshape: a tool that existed with nothing
 * behind it would teach an agent to try search first and fall back, which is a
 * round trip per session; a tool that silently degraded to an unranked `ILIKE`
 * scan would be worse, because the agent would believe the ordering meant
 * something. `opSearch` still refuses a resource with no declared index, with
 * the sentence that says so.
 */
const SEARCH_SCHEMA: JsonSchema = {
	type: 'object',
	properties: {
		resource: RESOURCE_PROP,
		query: {
			type: 'string',
			description:
				'What to search for. Understands quoted phrases, OR, and -term to exclude. A blank query returns nothing rather than everything — this ranks matches, it does not list rows.',
		},
		...LIMIT_PROPS,
	},
	required: ['resource', 'query'],
}
/**
 * The `plan_import` tool's arguments (keyed by argument since #320).
 *
 * `content` is the file as text, which is the honest shape for a protocol that
 * carries JSON: an agent that has a file has its text. The declared `maxRows`
 * still bounds the plan, and the reader still streams — a single string here is
 * the transport's constraint, not the pipeline's.
 */
const IMPORT_SCHEMA: JsonSchema = {
	type: 'object',
	properties: {
		importer: {
			type: 'string',
			description:
				'Importer key, as `describe_resources` reports it on the resource it loads into.',
		},
		content: {
			type: 'string',
			description:
				'the file, as text, in the format this importer declares. Returns a PLAN — what would be created, what would be updated, and which lines are rejected and why. Nothing is written: applying a plan is confirmed by a person on /imports/<key>, because a plan sent back over the wire is a caller-supplied list of writes.',
		},
	},
	required: ['importer', 'content'],
}

/**
 * `portal_exposure_report` takes nothing.
 *
 * Deliberately unparameterized: "which fields can the outside see?" is a
 * question about the whole spec, and a filtered answer is one somebody can be
 * shown while a portal they did not ask about is wide open. The report is short
 * by construction — a portal may expose at most 32 fields — so there is nothing
 * to page.
 */
const EMPTY_SCHEMA: JsonSchema = { type: 'object', properties: {} }

/**
 * The `render_document_<key>` tool's arguments.
 *
 * ## The decision this tool encodes, because #176 skipped it on purpose
 *
 * #174 shipped `search_<table>` beside its REST route, so the asymmetry — a
 * document has a URL and no tool — was going to be re-litigated by whoever
 * noticed it next. The answer is: **yes, a tool, and it never returns bytes.**
 *
 * The argument against a tool at all was that a document is bytes, and a base64
 * PDF is a large opaque payload in a context window. That argument is right
 * about *PDF* and wrong about *documents*: the PDF and the HTML are both
 * serializations of a `DocumentLayout`, which is structured text — headings,
 * paragraphs, label/value pairs, tables. An agent driving a billing workflow
 * wants to read the invoice and hand a person a link to it, and both of those
 * are served by returning the layout plus the URLs. Neither is served by
 * megabytes of base64 no model can read anyway.
 *
 * So: the blocks, the title, and the two links. No `format` argument, because
 * there is nothing to choose between — the caller gets the content in the one
 * form it can act on, and links for the forms it cannot.
 *
 * Offered only when some template declares `delivery.download`, on
 * `search_records`' reasoning: a tool that existed with nothing behind it
 * teaches an agent to try and fall back, which is a round trip per session. A
 * template that declares no download is absent from `describe_resources` and
 * refused by `opRenderDocument`.
 */
const RENDER_DOCUMENT_SCHEMA: JsonSchema = {
	type: 'object',
	properties: {
		document: {
			type: 'string',
			description:
				'Document template key, as `describe_resources` reports it on its resource.',
		},
		id: { type: 'string', description: 'The row to render this template for.' },
	},
	required: ['document', 'id'],
}

/**
 * The `query_records` tool's arguments.
 *
 * The schema is deliberately terse — it is broadcast on connect, and #320's
 * whole finding was that what rides on connect is what breaks at scale. The
 * edges an agent can name are not enumerated here for exactly that reason: they
 * live in `describe_resources { resource }` → `relations`, fetched on demand.
 *
 * There is no `sql`, no `join` and no `on`. A traversal names a *declared*
 * reference, which is what makes each hop authorizable — see `query.ts`.
 */
const QUERY_SCHEMA: JsonSchema = {
	type: 'object',
	properties: {
		resource: RESOURCE_PROP,
		where: {
			type: 'object',
			description:
				'Equality filters over this resource\'s own columns: {"status":"active"}. An unknown column is refused, not ignored.',
		},
		range: {
			type: 'object',
			description:
				'Inclusive bounds per column: {"healthScore":{"lte":50}}. gte and lte, either or both.',
		},
		traverse: {
			type: 'array',
			description: `Hops across DECLARED references — describe_resources { resource } → relations lists the edge names. Each item: { edge, where?, range?, required?, traverse? }. required:true keeps only root rows with a surviving match (an inner join) — that is how a joined question is asked. Nested traverse goes ${QUERY_LIMITS.maxDepth} deep, ${QUERY_LIMITS.maxEdges} edges total.`,
			items: { type: 'object' },
		},
		limit: {
			type: 'number',
			description: `Root rows to return (default ${QUERY_LIMITS.defaultLimit}, max ${QUERY_LIMITS.maxLimit}).`,
		},
		offset: { type: 'number', description: 'Root rows to skip (default 0).' },
		orderBy: { type: 'string', description: 'A column of the root resource.' },
		orderDir: { type: 'string', enum: ['asc', 'desc'] },
	},
	required: ['resource'],
}

const ID_SCHEMA: JsonSchema = {
	type: 'object',
	properties: { resource: RESOURCE_PROP, id: { type: 'string' } },
	required: ['resource', 'id'],
}

const CREATE_SCHEMA: JsonSchema = {
	type: 'object',
	properties: {
		resource: RESOURCE_PROP,
		data: {
			type: 'object',
			description:
				'The new row. Field names, types and which are required come from `describe_resources { resource }` → `createSchema` — fetch it rather than guessing; invalid input is refused per field, not silently dropped.',
		},
	},
	required: ['resource', 'data'],
}

const UPDATE_SCHEMA: JsonSchema = {
	type: 'object',
	properties: {
		resource: RESOURCE_PROP,
		id: { type: 'string' },
		data: {
			type: 'object',
			description:
				'The fields to change. Shape comes from `describe_resources { resource }` → `updateSchema`.',
		},
	},
	required: ['resource', 'id', 'data'],
}

/**
 * `run_action` — one tool for every declared list action, not one per action.
 *
 * The action key is an *argument*, exactly as the resource name is, and for
 * #320's reason: a tool per declared action is O(entities × actions) entries on
 * connect, which is the growth that made the tool list unusable and that the
 * fixed vocabulary exists to remove. What each action writes, how many rows it
 * may touch and what may be chosen come from
 * `describe_resources { resource } → actions`.
 *
 * `ids` is an explicit array and there is deliberately no `filter` spelling.
 * Everything the epic says about a human ticking boxes applies harder to an
 * agent: "everything matching the current filter" resolves the set server-side
 * after the count was read, and an agent that mis-formed the filter learns how
 * many rows it changed afterwards.
 */
const RUN_ACTION_SCHEMA: JsonSchema = {
	type: 'object',
	properties: {
		resource: RESOURCE_PROP,
		action: {
			type: 'string',
			description:
				'The action key, from `describe_resources { resource }` → `actions[].key`.',
		},
		ids: {
			type: 'array',
			items: { type: 'string' },
			description:
				'The rows to act on, by id. An explicit list — there is no "everything matching a filter" spelling, deliberately. Over the action\'s declared maxSelection the whole run is refused rather than truncated.',
		},
		choice: {
			type: 'string',
			description:
				"Required iff the action declares `choose`, and must be one of that field's declared options.",
		},
		batchId: {
			type: 'string',
			description:
				'Correlates the batch audit entry with the per-row ones. Supply your own so you can find this run in the log afterwards.',
		},
	},
	required: ['resource', 'action', 'ids', 'batchId'],
}

const ACTIONS: SproutAction[] = ['read', 'create', 'update', 'delete']

/**
 * Which of the four actions this identity may perform on this resource,
 * **row-lessly** — the same `canPerformAction` the per-resource tools were gated
 * on, with no row fetched. An `owner` rule denies without a row, so an
 * owner-gated action is absent here exactly as its tool used to be absent, and
 * `executeMCPTool` re-authorizes with the row regardless.
 */
async function allowedActions(
	entry: RegisteredResource,
	ctx: ReturnType<typeof createAccessContext>,
): Promise<SproutAction[]> {
	const out: SproutAction[] = []
	for (const action of ACTIONS)
		if (
			await canPerformAction(
				entry.resource.name,
				entry.config.access,
				action,
				ctx,
			)
		)
			out.push(action)
	return out
}

/** Importers this identity may plan: a write, so `create` — and `update` too
 * when an upsert key means planning one produces updates. */
function usableImporters(
	entry: RegisteredResource,
	actions: SproutAction[],
): NonNullable<RegisteredResource['config']['importers']> {
	if (!actions.includes('create')) return []
	return (entry.config.importers ?? []).filter(
		(i) => !i.paused && (!i.upsertColumn || actions.includes('update')),
	)
}

/** Downloadable templates, gated on `read` — rendering a document IS a read of
 * the row (`opRenderDocument` is built out of `opGet`/`opList`), so offering one
 * where the row is unreadable would be a second door into it. */
function readableDocuments(
	entry: RegisteredResource,
	actions: SproutAction[],
): NonNullable<RegisteredResource['config']['documents']> {
	if (!actions.includes('read')) return []
	return (entry.config.documents ?? []).filter((d) => d.download)
}

/**
 * Build the RBAC-gated tool list for a user (row-less gating).
 *
 * **Fixed size.** The returned list has at most ten entries whatever the
 * registry holds — see the header for why that is the fix to #320 and why
 * pagination is not. A verb appears when at least one reachable resource permits
 * it; which resources those are is `describe_resources`' answer, not this list's.
 */
export async function generateMCPTools(
	registry: ResourceRegistry,
	user: SproutUser | null,
): Promise<McpTool[]> {
	const tools: McpTool[] = []
	const ctx = createAccessContext(user)
	const entries = registry.all()
	const permitted = new Set<SproutAction>()
	let anySearch = false
	let anyDocument = false
	let anyImporter = false
	let reachable = 0
	const readable = new Set<string>()
	for (const entry of entries) {
		const actions = await allowedActions(entry, ctx)
		if (actions.length === 0) continue
		reachable += 1
		for (const action of actions) permitted.add(action)
		if (actions.includes('read')) readable.add(entry.resource.name)
		if (actions.includes('read') && entry.config.search) anySearch = true
		if (readableDocuments(entry, actions).length > 0) anyDocument = true
		if (usableImporters(entry, actions).length > 0) anyImporter = true
	}
	// A traversable pair is one declared reference whose BOTH ends this caller may
	// read. Checked forward only, which is sufficient: a reverse edge is the same
	// pair read the other way, so a pair with no forward relation has no inverse
	// either. Offered only when such a pair exists, on `search_records`' reasoning
	// — a tool with nothing behind it teaches an agent to try and fall back.
	const anyTraversal = entries.some(
		(entry) =>
			readable.has(entry.resource.name) &&
			entry.resource.relations.some((r) => readable.has(r.references.table)),
	)
	// The exposure report — offered whenever anything in this
	// registry declares a portal, so an agent auditing a spec does not have to be
	// told the tool exists. It reads declarations, never rows, so it is gated on
	// nothing: it discloses what is *already* public, which is the one class of
	// fact that cannot be leaked by describing it.
	if (registry.all().some((e) => (e.config.portals?.length ?? 0) > 0))
		tools.push({
			name: 'portal_exposure_report',
			description:
				'Every field every declared portal exposes, with its audience and whether it is readable, creatable or updatable from outside. The review artifact for public surfaces: read it before approving a portals.declare or a portals.setFields. Reads declarations only — it cannot drift from what the runtime enforces. There is no tool that mints a portal token, deliberately: a minted token is a bearer credential that would land in a transcript nobody can revoke.',
			inputSchema: EMPTY_SCHEMA,
		})
	// Discovery first, and offered whenever anything is reachable: it is the only
	// place resource names, field schemas and per-resource capabilities live now,
	// so an agent that ignored it would be guessing.
	if (reachable > 0)
		tools.push({
			name: 'describe_resources',
			description: `What this app holds and what you may do with it: ${reachable} resource(s). Call it with no arguments for the index — every resource you may touch, the actions you may perform on each, and whether it declares search, documents or importers. Call it with { resource } for that one resource in full, including the create and update field schemas the record tools take. Start here: every other data tool takes a resource name from this one.`,
			inputSchema: DESCRIBE_SCHEMA,
		})
	if (permitted.has('read')) {
		tools.push({
			name: 'list_records',
			description:
				'List records of one resource, newest first, paged. The plain read: use `search_records` when you have a query and this when you want rows.',
			inputSchema: LIST_SCHEMA,
		})
		tools.push({
			name: 'get_record',
			description: 'Get one record of one resource by id.',
			inputSchema: ID_SCHEMA,
		})
	}
	if (anyTraversal)
		tools.push({
			name: 'query_records',
			description:
				'Answer ONE question that spans several resources, in one call: a root resource, a filter over its own fields, and hops across the references the spec declares. "Customers with an active campaign whose health score is below 50" is one call here and four paginated calls plus a hand-join otherwise. Every hop runs the joined resource\'s own read rule and org scope, so it reaches exactly what a direct read would; the walk is bounded and says so when a bound bit.',
			inputSchema: QUERY_SCHEMA,
		})
	if (anySearch)
		tools.push({
			name: 'search_records',
			description:
				'Search one resource by relevance, highest-ranked first. Available only on resources that declare a search index — `describe_resources` says which.',
			inputSchema: SEARCH_SCHEMA,
		})
	if (anyDocument)
		tools.push({
			name: 'render_document',
			description:
				"Render a declared document template for one record: returns the document's text content and its download links — never file bytes. `describe_resources` lists the templates each resource declares.",
			inputSchema: RENDER_DOCUMENT_SCHEMA,
		})
	if (anyImporter)
		tools.push({
			name: 'plan_import',
			description:
				'Dry-run a declared importer over a file. Reports what would be created, what would be updated and which lines are rejected and why; writes nothing. Applying a plan is confirmed by a person on /imports/<key> — a plan sent back over the wire is a caller-supplied list of writes.',
			inputSchema: IMPORT_SCHEMA,
		})
	if (permitted.has('create'))
		tools.push({
			name: 'create_record',
			description:
				"Create one record. Get the field schema from `describe_resources { resource }` first — it is not inlined here, deliberately: broadcasting every resource's fields on connect is what made this tool list unusable at scale.",
			inputSchema: CREATE_SCHEMA,
		})
	if (permitted.has('update'))
		tools.push({
			name: 'update_record',
			description:
				'Update one record by id, with the fields to change. Field schema from `describe_resources { resource }`.',
			inputSchema: UPDATE_SCHEMA,
		})
	// Offered only when something reachable actually declares an action, on
	// `search_records`' reasoning: a tool with nothing behind it teaches an agent
	// to try it and fall back. Gated on `update` because running one IS an update.
	if (
		permitted.has('update') &&
		entries.some((e) => (e.config.actions?.length ?? 0) > 0)
	)
		tools.push({
			name: 'run_action',
			description:
				"Run a declared list action over an explicit set of rows — the same named, capped, role-gated operation the app's own toolbar runs, not a loop of updates. What it writes comes from the spec, never from you: you supply the rows and, when the action declares one, a choice from its declared options. `describe_resources { resource }` lists each action, what it sets, its cap and whether it can be undone. A run over the cap is refused whole rather than truncated; a run may partially succeed, and the reply names every row that did not, by id and reason.",
			inputSchema: RUN_ACTION_SCHEMA,
		})
	if (permitted.has('delete'))
		tools.push({
			name: 'delete_record',
			description: 'Delete one record of one resource by id.',
			inputSchema: ID_SCHEMA,
		})
	return tools
}

/**
 * `describe_resources` — the on-demand half of the fixed vocabulary.
 *
 * Row-less, like the tool list it replaced: a resource appears only when the
 * caller may perform *some* action on it, and only the permitted actions are
 * reported. It is not an enumeration of what the caller cannot read.
 */
async function describeResources(
	registry: ResourceRegistry,
	user: SproutUser | null,
	args: Record<string, unknown>,
): Promise<unknown> {
	const ctx = createAccessContext(user)
	const wanted = typeof args.resource === 'string' ? args.resource : undefined
	if (wanted !== undefined) {
		const entry = registry.get(wanted)
		const actions = entry ? await allowedActions(entry, ctx) : []
		// One sentence for "no such resource" and for "not yours", on purpose: a
		// distinguishable answer is an existence oracle over the whole registry.
		if (!entry || actions.length === 0) throw new UnknownResourceError(wanted)
		return {
			name: entry.resource.name,
			label: entry.label,
			actions,
			...describeExtras(entry, actions),
			// The traversable edges — the names `query_records` takes,
			// which is why they are here rather than enumerated in that tool's schema:
			// an enum of edges is O(entities) on connect, the growth #320 removed.
			//
			// Filtered to resources this caller may read, and only offered to a caller
			// who may read *this* one. That keeps it from being an existence oracle:
			// naming an edge to a resource whose rules deny you would disclose both
			// that the resource exists and that it points here.
			...(actions.includes('read')
				? await relationsFor(registry, entry, ctx)
				: undefined),
			// The row shape, only for a caller that may read rows.
			fields: actions.includes('read')
				? entry.resource.columns.map((c) => ({
						name: c.name,
						type: c.type,
						nullable: c.nullable,
						...(c.isPrimaryKey ? { primaryKey: true } : {}),
						...(c.hasDefault ? { hasDefault: true } : {}),
						...(c.enumValues ? { enumValues: c.enumValues } : {}),
						...(c.references ? { references: c.references.table } : {}),
						...((c.meta.description ?? c.meta.label)
							? { description: c.meta.description ?? c.meta.label }
							: {}),
						// What the spec declared about filtering this column (#414),
						// reported only where it was declared. An agent that cannot see
						// the declaration learns it by being refused, which costs a round
						// trip to discover something the app already knows and is the
						// asymmetry `describe_resources` exists to remove.
						...(c.meta.filterable === false ? { filterable: false } : {}),
						...(c.meta.filterOperators?.length
							? { filterOperators: c.meta.filterOperators }
							: {}),
					}))
				: undefined,
			createSchema: actions.includes('create')
				? generateInputSchema(entry, 'create')
				: undefined,
			updateSchema: actions.includes('update')
				? generateInputSchema(entry, 'update')
				: undefined,
		}
	}
	const limit = typeof args.limit === 'number' ? Math.max(0, args.limit) : 100
	const offset = typeof args.offset === 'number' ? Math.max(0, args.offset) : 0
	const rows: unknown[] = []
	let total = 0
	for (const entry of registry.all()) {
		const actions = await allowedActions(entry, ctx)
		if (actions.length === 0) continue
		total += 1
		if (total <= offset || rows.length >= limit) continue
		rows.push({
			name: entry.resource.name,
			label: entry.label,
			group: entry.config.group ?? 'Other',
			actions,
			fieldCount: entry.resource.columns.length,
			...describeExtras(entry, actions),
		})
	}
	return {
		resources: rows,
		total,
		offset,
		...(offset + rows.length < total
			? { nextOffset: offset + rows.length }
			: {}),
		note: 'Call describe_resources { resource } for one resource in full, including its create/update field schemas.',
	}
}

/**
 * The declared edges `query_records` can walk from this resource,
 * narrowed to the far sides this caller may read.
 *
 * Row-less, like everything else `describe_resources` reports: `canPerformAction`
 * decides, no row is fetched, and an edge the caller could not traverse is simply
 * absent rather than listed-and-refused.
 */
async function relationsFor(
	registry: ResourceRegistry,
	entry: RegisteredResource,
	ctx: ReturnType<typeof createAccessContext>,
): Promise<{ relations?: unknown[] }> {
	const out: unknown[] = []
	for (const edge of queryEdges(registry, entry)) {
		const target = registry.get(edge.resource)
		if (!target) continue
		if (
			!(await canPerformAction(
				target.resource.name,
				target.config.access,
				'read',
				ctx,
			))
		)
			continue
		out.push({
			edge: edge.name,
			kind: edge.kind,
			resource: edge.resource,
			label: edge.label,
			via: edge.column,
		})
	}
	return out.length > 0 ? { relations: out } : {}
}

/** The declared extras an agent needs to know exist before it can ask for them. */
function describeExtras(
	entry: RegisteredResource,
	actions: SproutAction[],
): Record<string, unknown> {
	const documents = readableDocuments(entry, actions)
	const importers = usableImporters(entry, actions)
	// Declared actions, gated on `update` — running one IS an update of the rows
	// (`opRunAction` is built out of `opGet`/`opUpdate`), so offering one where
	// the rows are unwritable would advertise a door that is locked. The declared
	// `role` is NOT checked here: it is a batch gate enforced in the op, and a
	// caller who holds `update` but not the role should be told the action exists
	// and refused when they run it, rather than shown a registry that quietly
	// differs per person.
	const listActions = actions.includes('update')
		? (entry.config.actions ?? [])
		: []
	return {
		...(actions.includes('read') && entry.config.search
			? { search: true }
			: {}),
		...(documents.length > 0
			? {
					documents: documents.map((d) => ({
						key: d.key,
						description: d.description,
					})),
				}
			: {}),
		...(importers.length > 0
			? {
					importers: importers.map((i) => ({
						key: i.key,
						description: i.description,
					})),
				}
			: {}),
		...(listActions.length > 0
			? {
					actions: listActions.map((a) => ({
						key: a.key,
						label: a.label,
						description: a.description,
						arity: a.arity,
						// The three facts an agent needs before calling `run_action`:
						// what it writes, how many rows it may aim at, and what it may
						// pick. Inlined here rather than in the tool schema for #320's
						// reason — an enum of every action on connect is O(entities).
						writes: a.set,
						...(a.choose
							? {
									choose: { field: a.choose.column, options: a.choose.options },
								}
							: {}),
						maxSelection: a.maxSelection,
						undoable: a.undoable,
						...(a.role ? { role: a.role } : {}),
					})),
				}
			: {}),
	}
}

function ok(data: unknown): McpToolResult {
	return { content: [{ type: 'text', text: JSON.stringify(data) }] }
}
function err(message: string): McpToolResult {
	return { content: [{ type: 'text', text: message }], isError: true }
}

/**
 * How reachable the transport carrying this tool call is — a property of the
 * **host**, declared by the host, never inferred here.
 *
 * `'local'` is a transport whose only possible caller is the developer's own
 * machine: `maxstack mcp`, the stdio server the agent client spawns as a child
 * process. It already has the project's files, the terminal it was launched
 * from and the developer's own credentials; there is nothing an error message
 * could tell it that it is not entitled to know, and the detail is the entire
 * debugging value of the reply.
 *
 * `'network'` is a transport that answers somebody else: `POST /mcp` in a
 * deployed app, reached over HTTP with a session cookie or an API key. That is
 * the #336 threat model exactly — the CRUD tools run the same ops, over the same
 * driver, as the REST handlers, so an unrecognised failure's `message` is the
 * failed statement: the SQL, every column in the projection, and the caller's
 * own bound parameters. It also does not stay with the caller: a tool result is
 * transcript, and a transcript is copied into issues, logs and other people's
 * context windows.
 *
 * **`'network'` is the default everywhere it is not stated** ({@link mcpFail},
 * `executeMCPTool`, `executePlatformTool`, `handleMcpRequest`). A host that
 * forgets to declare itself gets the safe answer, and the only way to opt into
 * detail is to say so — which is the direction #336 chose for classes and this
 * keeps for transports.
 */
export type McpExposure = 'local' | 'network'

/**
 * The failure boundary for every MCP tool result — `fail()` in `api.ts`, in the
 * shape MCP replies in.
 *
 * It draws the *same* line, by the same test: an error we **constructed** was
 * written for the caller and goes back verbatim; anything else arrived from the
 * driver or the store and becomes a fixed string plus a correlation id, with the
 * detail on stderr in `error-id.ts`'s one line shape. The discriminator is class
 * membership and never a scan of the message text, so an error type added later
 * is generic until somebody deliberately maps it here.
 *
 * This deliberately duplicates none of `fail()`'s logic and all of its list:
 * they cannot share a body because one returns an HTTP status and the other a
 * `McpToolResult`, but a class that is answerable over REST and opaque over MCP
 * (or the reverse) would be exactly the layer disagreement `executeMCPTool`'s
 * "take the whole OpContext" note exists to prevent. If you add a case to one,
 * add it to the other.
 *
 * The one difference between the two surfaces is {@link McpExposure}: on a local
 * transport the detail is appended to the reply as well as printed, because the
 * agent reading it is the same principal as the operator who would otherwise go
 * and grep for the id — making it walk to stderr to read its own database's
 * error buys no confidentiality and costs the round trip the tool exists to
 * save. The id is minted and logged either way, so the two hosts' logs are the
 * same and an id quoted from either one resolves.
 */
export function mcpFail(
	e: unknown,
	context: ErrorContext,
	exposure: McpExposure = 'network',
): McpToolResult {
	// An update body with nothing writable in it (#388). Named **above**
	// `ValidationError`, whose subclass it is, for the same reason `fail()` gives
	// it a 400 rather than a 422: it rejects no field, so its `fieldErrors` is
	// `{}` — the line below would answer an agent that mistyped a field name with
	// the string "{}". The whole repair instruction is in the message.
	if (e instanceof EmptyUpdateError) return err(e.message)
	// Repair instructions, machine-readably — the same contract the 422 body
	// carries, so an agent and a browser client act on one shape.
	if (e instanceof ValidationError) return err(JSON.stringify(e.fieldErrors))
	if (
		// A declared WIP limit. An agent driving MCP hits the same rule as a person
		// dragging a card, and gets told which column is full and by how much
		// rather than a generic failure.
		e instanceof LimitExceededError ||
		// A duplicate, or any other integrity violation, already classified by
		// SQLSTATE at the store boundary (`constraints.ts`, #352). The constructed
		// error carries the resource, the constraint identifier and the *declared*
		// columns — never the driver's `message`, `detail`, `query` or `params`.
		// `ConflictError` is a subclass of `ConstraintViolationError`, so testing
		// them together is safe here where the REST side has to order them.
		e instanceof ConstraintViolationError ||
		e instanceof ConflictError ||
		e instanceof PermissionError ||
		e instanceof NotFoundError ||
		// An undeclared index, reported as the sentence saying so rather than as an
		// empty result an agent would read as "nothing matched".
		e instanceof UnsupportedOperationError ||
		e instanceof UnknownResourceError ||
		// A spent portal budget. "Try again later" is addressed to the caller and
		// is the one thing that stops an agent retrying immediately.
		e instanceof RateLimitedError ||
		// The three list-action refusals. Named explicitly, because every one of
		// them is a repair instruction an agent can act on — the cap it exceeded,
		// the options it may choose from, the action that does not exist — and the
		// generic fallback below would turn each into "Internal error", which an
		// agent retries verbatim.
		e instanceof SelectionTooLargeError ||
		e instanceof InvalidActionChoiceError ||
		e instanceof UnknownActionError
	) {
		return err(e.message)
	}
	const errorId = nextErrorId()
	reportInternalError(e, errorId, context)
	const detail = e instanceof Error ? e.message : String(e)
	return err(
		exposure === 'local'
			? `Internal error [${errorId}]: ${detail}`
			: `Internal error [${errorId}]. The detail is on the server's stderr under this id.`,
	)
}

/** The pre-#320 per-resource names, still executable though no longer listed. */
const TOOL_RE = /^(list|search|get|create|update|delete)_(.+)$/

/** The fixed vocabulary's data tools → the verb each dispatches. */
const GENERIC_VERBS: Record<string, string | undefined> = {
	list_records: 'list',
	get_record: 'get',
	search_records: 'search',
	create_record: 'create',
	update_record: 'update',
	delete_record: 'delete',
}

/**
 * The exposure report, derived from the **grounded** portals on the registry.
 *
 * The spec-layer `portalExposureReport` is the canonical one and is what
 * `maxstack validate` and the workbench print; this is the same fold over the
 * grounded plans, because `@maxstack/core` does not depend on `@maxstack/spec`.
 * The two are pinned to one answer by `apps/web/app/portals.agreement.test.ts`,
 * which asserts the runtime returns exactly the fields the spec-layer report
 * lists.
 */
function portalExposureFromRegistry(registry: ResourceRegistry): unknown {
	const rows: {
		portal: string
		audience: string
		resource: string
		field: string
		access: string
		paused: boolean
	}[] = []
	for (const entry of registry.all())
		for (const portal of entry.config.portals ?? []) {
			for (const field of portal.readFields)
				rows.push({
					portal: portal.key,
					audience: portal.audience,
					resource: entry.resource.name,
					field,
					access: 'read',
					paused: portal.paused,
				})
			for (const write of portal.writes)
				for (const field of write.fields)
					rows.push({
						portal: portal.key,
						audience: portal.audience,
						resource: entry.resource.name,
						field,
						access: write.action,
						paused: portal.paused,
					})
		}
	rows.sort(
		(a, b) =>
			a.portal.localeCompare(b.portal) ||
			a.access.localeCompare(b.access) ||
			a.field.localeCompare(b.field),
	)
	return { exposed: rows }
}

/** The one tool name that is keyed on an importer rather than on a resource. */
const IMPORT_TOOL_PREFIX = 'plan_import_'

/** Keyed on a document template rather than on a resource — same reasoning as
 * the importer prefix above: a template key is not a resource name, and the two
 * namespaces must not be able to collide. */
const DOCUMENT_TOOL_PREFIX = 'render_document_'

/** One string as the chunk stream the readers take. */
async function* textChunks(text: string): AsyncGenerator<string> {
	yield text
}

/**
 * A plan, as much of it as is useful to an agent.
 *
 * The rejected lines carry their reasons in full — that is the half an agent can
 * act on by fixing the file. The accepted rows are counted rather than echoed:
 * returning every validated value would be handing back a write list, which is
 * the thing this tool deliberately does not traffic in.
 */
function importPlanSummary(plan: ImportPlan): unknown {
	return {
		importer: plan.key,
		resource: plan.resource,
		wouldCreate: plan.counts.create,
		wouldUpdate: plan.counts.update,
		rejected: plan.rows
			.filter((r) => r.action === 'invalid')
			.map((r) => ({ line: r.line, errors: r.errors })),
		applied: false,
		confirmAt: `/imports/${plan.key}`,
	}
}

/**
 * Execute a tool call, re-authorizing server-side (with the row for
 * get/update/delete) and validating create/update input.
 *
 * Takes the whole {@link OpContext} rather than the three fields it used to,
 * so an agent driving MCP sees exactly what a REST caller sees — including the
 * derived values a host wired up. Anything reachable only by
 * hand-assembling a narrower context here is a surface the two layers disagree
 * about, which is the thing the enforce-at-every-layer invariant exists to
 * prevent.
 *
 * Every failure leaves through {@link mcpFail}, which is `api.ts`'s `fail()`
 * rule: constructed errors verbatim, everything else generic plus a correlation
 * id (#353). `exposure` defaults to `'network'` because that is where this half
 * of the surface actually lives — the CRUD tools need a registry and a store, so
 * the only host that wires them is the web app's `POST /mcp`. The parameter
 * exists anyway rather than being hardcoded, because "there is one host" is the
 * assumption that made this a bug in the first place.
 */
export async function executeMCPTool(
	ctx: OpContext,
	toolName: string,
	args: Record<string, unknown>,
	exposure: McpExposure = 'network',
): Promise<McpToolResult> {
	if (toolName === 'portal_exposure_report')
		return ok(portalExposureFromRegistry(ctx.registry))
	// The fixed vocabulary: the resource is an argument. Resolved before
	// the legacy names below, so a resource literally called `records` cannot
	// shadow `list_records`.
	const generic = GENERIC_VERBS[toolName]
	// A key-parameterized tool, resolved the same way its per-key name used to be
	// — an importer or template key is not a resource name, and the namespaces
	// must not be able to collide.
	const importKey =
		toolName === 'plan_import'
			? String(args.importer ?? '')
			: toolName.startsWith(IMPORT_TOOL_PREFIX)
				? toolName.slice(IMPORT_TOOL_PREFIX.length)
				: undefined
	if (importKey !== undefined) {
		try {
			const plan = await planImport(
				ctx,
				importKey,
				textChunks(String(args.content ?? '')),
			)
			return ok(importPlanSummary(plan))
		} catch (e) {
			return mcpFail(
				e,
				{ resource: importKey, operation: 'plan_import' },
				exposure,
			)
		}
	}
	const documentKey =
		toolName === 'render_document'
			? String(args.document ?? '')
			: toolName.startsWith(DOCUMENT_TOOL_PREFIX)
				? toolName.slice(DOCUMENT_TOOL_PREFIX.length)
				: undefined
	if (documentKey !== undefined) {
		try {
			const { layout } = await opRenderDocument(
				ctx,
				documentKey,
				String(args.id),
			)
			return ok({
				document: documentKey,
				title: layout.title,
				// The content, in the one shape an agent can act on. Not bytes: see
				// RENDER_DOCUMENT_SCHEMA.
				blocks: layout.blocks,
				// The links, for the shapes it cannot — what an agent hands a person.
				html: `/documents/${documentKey}/${String(args.id)}.html`,
				pdf: `/documents/${documentKey}/${String(args.id)}.pdf`,
			})
		} catch (e) {
			return mcpFail(
				e,
				{ resource: documentKey, operation: 'render_document' },
				exposure,
			)
		}
	}
	// One question spanning several resources. Dispatched here rather
	// than through `GENERIC_VERBS` because it is not a verb over one resource —
	// and it still reaches the store only through `opList`/`opGetMany`, so it is
	// not a second read path either.
	if (toolName === 'query_records') {
		try {
			return ok(await opQuery(ctx, parseQuerySpec(args)))
		} catch (e) {
			return mcpFail(
				e,
				{ resource: String(args.resource ?? 'query'), operation: 'query' },
				exposure,
			)
		}
	}
	// Dispatched here rather than through `GENERIC_VERBS` because it is not a
	// verb over one resource — it is a named operation the *spec* defines. It
	// still reaches the store only through `opGet`/`opUpdate`, so it is not a
	// second write path either.
	if (toolName === 'run_action') {
		try {
			return ok(
				await opRunAction(
					ctx,
					String(args.resource ?? ''),
					String(args.action ?? ''),
					{
						ids: Array.isArray(args.ids) ? args.ids.map(String) : [],
						...(typeof args.choice === 'string' ? { choice: args.choice } : {}),
						batchId: String(args.batchId ?? ''),
					},
				),
			)
		} catch (e) {
			return mcpFail(
				e,
				{
					resource: String(args.resource ?? ''),
					operation: `action:${String(args.action ?? '')}`,
				},
				exposure,
			)
		}
	}
	if (toolName === 'describe_resources') {
		try {
			return ok(await describeResources(ctx.registry, ctx.user ?? null, args))
		} catch (e) {
			return mcpFail(
				e,
				{ resource: 'registry', operation: 'describe' },
				exposure,
			)
		}
	}
	// The pre-#320 per-resource names. Unadvertised, still executable: a live
	// session, a saved transcript or a script holding `list_task` should not break
	// on the day the list stopped naming it. Same ops, same gate — only discovery
	// changed.
	const match = generic ? undefined : TOOL_RE.exec(toolName)
	if (!generic && !match) return err(`Unknown tool: ${toolName}`)
	const verb = generic ?? match?.[1] ?? ''
	const resourceName = generic
		? String(args.resource ?? '')
		: (match?.[2] ?? '')
	// Legacy `create_<table>` took the row at the top level; `create_record` takes
	// it under `data`, so the resource name has somewhere to live.
	const data = generic
		? ((args.data ?? {}) as Record<string, unknown>)
		: verb === 'create'
			? args
			: ((args.data ?? {}) as Record<string, unknown>)

	try {
		switch (verb) {
			case 'list':
				return ok(
					await opList(ctx, resourceName, {
						limit: typeof args.limit === 'number' ? args.limit : undefined,
						offset: typeof args.offset === 'number' ? args.offset : undefined,
					}),
				)
			case 'search':
				return ok(
					await opSearch(ctx, resourceName, String(args.query ?? ''), {
						limit: typeof args.limit === 'number' ? args.limit : undefined,
						offset: typeof args.offset === 'number' ? args.offset : undefined,
					}),
				)
			case 'get':
				return ok(await opGet(ctx, resourceName, String(args.id)))
			case 'create':
				return ok(await opCreate(ctx, resourceName, data))
			case 'update':
				return ok(await opUpdate(ctx, resourceName, String(args.id), data))
			case 'delete':
				return ok({
					success: await opDelete(ctx, resourceName, String(args.id)),
				})
			default:
				return err(`Unknown verb: ${verb}`)
		}
	} catch (e) {
		// The class list this used to inline moved into `mcpFail`, which is where
		// the fallback lives too — the two have to be read together or the fallback
		// silently swallows a refusal the caller could have acted on (#352).
		return mcpFail(e, { resource: resourceName, operation: verb }, exposure)
	}
}
