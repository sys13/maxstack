/**
 * The **generated page surface's** contract, per page.
 *
 * `api-contract.ts` next door ends the guessing for `/api/<resource>`. This is
 * the same defect one level up (#376): an agent that had built the app could
 * not verify a delete, because the page's *own* routes were documented nowhere
 * it could reach. It found `/new` and `/<id>` by grepping rendered HTML for
 * `href=`, guessed `{"intent":"delete"}` → 500, guessed `DELETE /<id>` → 500,
 * and reported the delete path unverified — over a button that works.
 *
 * The page routes are what a *user* clicks, and therefore what an e2e-shaped
 * verification drives. The REST layer got a published contract; they did not.
 *
 * **Derived, not restated — and read from both sides.** The endpoint list below
 * is the single statement of what a page surface accepts. `query_spec
 * {section:"pages"}` publishes it, and the actions in `apps/web`
 * (`project.new.server.ts`, `project.edit.server.ts`) compose their *refusals*
 * out of it through {@link acceptedBodies} and {@link allowedMethods}. So the
 * sentence a caller reads after a wrong guess and the sentence the tool
 * publishes are the same sentence, and neither can drift from the other by
 * being edited alone.
 *
 * It lives in core rather than in `apps/web` for the reason `grounding.ts`
 * gives about entity shapes: `@maxstack/mcp` may not import the app, and a
 * contract derived from a second fold would describe a slightly different
 * application than the one being served. It takes a structural page shape
 * rather than a `PageSpec`, so core still carries no dependency on
 * `@maxstack/spec`.
 *
 * The one thing repeated here is the slug-joining rule, which `apps/web` owns
 * in `page-path.ts` and cannot share: that module is deliberately dependency-
 * free because *client* components import it, and importing core there is how
 * #251 shipped ts-morph to the browser. The duplication is pinned by an
 * agreement test in `apps/web` that resolves every published path back through
 * `matchProjectPath`, in the same way `blast-radius.ts`'s `resourceName` is
 * pinned.
 */

/** Just enough of a composed page route to state its contract. */
export interface PageContractInput {
	/** The declared route, e.g. `/decks` — `/` for the app's root page. */
	route: string
	/** The resource its writes go to, e.g. `deck`. `null` = no backing entity. */
	resource: string | null
}

/** One request a page surface serves. */
export interface PageEndpoint {
	/** Method and path, e.g. `POST /decks/:id`. */
	request: string
	/** What this request does, in one clause. */
	purpose: string
	/**
	 * The body, spelled as a caller sends it, content type included — because on
	 * `POST <page>/:id` the content type **is** the discriminator between an
	 * update and a delete. `null` for a request that takes no body.
	 */
	body: string | null
}

/** Everything one page serves, and what each URL accepts. */
export interface PageContract {
	/** The declared route this contract is for. */
	route: string
	/** The resource its writes go to; `null` for a page with no backing entity. */
	resource: string | null
	/** Every request the page serves, in the order a client meets them. */
	endpoints: PageEndpoint[]
}

/**
 * `/decks` + `new` → `/decks/new`; the root page's `/` + `new` → `/new`.
 *
 * The empty-part filter is the whole content: **the root page's slug is the
 * empty string**, and interpolating it yields `//new`, which a browser reads as
 * the protocol-relative URL `https://new/`. This mirrors `pagePath` in
 * `apps/web/app/page-path.ts` — see this module's header for why the rule is
 * stated twice and how the copies are pinned together.
 */
const under = (route: string, ...rest: string[]): string =>
	`/${[route.replace(/^\/+/, '').replace(/\/+$/, ''), ...rest]
		.filter((part) => part !== '')
		.join('/')}`

/** `<page>/:id` — the record surface, which is where both wrong guesses landed. */
export const pageRecordPath = (route: string): string => under(route, ':id')

/** `<page>/new` — the create surface. */
export const pageCreatePath = (route: string): string => under(route, 'new')

/** The contract of one composed page route. */
export function pageContract(page: PageContractInput): PageContract {
	const { route, resource } = page
	const list = under(route)
	if (!resource)
		return {
			route,
			resource: null,
			endpoints: [{ request: `GET ${list}`, purpose: 'the page', body: null }],
		}
	const create = pageCreatePath(route)
	const parse = under(route, 'parse')
	const record = pageRecordPath(route)
	const json = 'content-type: application/json'
	// A form body is what a browser sends, so both of the encodings a browser
	// can produce are named — a caller reproducing the delete with `curl -d`
	// sends the first and would otherwise be guessing again.
	const form =
		'content-type: application/x-www-form-urlencoded or multipart/form-data'
	return {
		route,
		resource,
		endpoints: [
			{ request: `GET ${list}`, purpose: 'the list', body: null },
			{ request: `GET ${create}`, purpose: 'the create form', body: null },
			{
				request: `POST ${create}`,
				purpose: `create a ${resource}`,
				body: `a JSON object of field values (${json}) — the \`create\` schema for \`${resource}\` under query_spec {section:"api"}`,
			},
			{
				request: `POST ${parse}`,
				purpose: 'draft field values from a sentence',
				body: `\`{"text": "..."}\` (${json}); 503 when no model is configured`,
			},
			{ request: `GET ${record}`, purpose: 'the record', body: null },
			{
				request: `POST ${record}`,
				purpose: `update the ${resource}`,
				// "at least one" is not padding: unknown keys are stripped, so a body
				// of only unknown keys used to validate into `{}` and 500 (#388). The
				// contract now says what `opUpdate` enforces.
				body: `a JSON object of at least one field value (${json}) — the \`update\` schema for \`${resource}\` under query_spec {section:"api"}`,
			},
			{
				request: `POST ${record}`,
				purpose: `delete the ${resource}`,
				body: `a form body with \`intent=delete\` (${form}), or \`DELETE /api/${resource}/:id\``,
			},
		],
	}
}

/** The path half of a `METHOD /path` request line. */
const pathOf = (request: string): string =>
	request.slice(request.indexOf(' ') + 1)

/**
 * The methods a page serves at one path — an `Allow` header's value.
 *
 * Derived from the endpoint list rather than written beside it, so a refusal
 * cannot name a verb the page stopped serving.
 */
export function allowedMethods(contract: PageContract, path: string): string {
	const methods = new Set(
		contract.endpoints
			.filter((e) => pathOf(e.request) === path)
			.map((e) => e.request.slice(0, e.request.indexOf(' '))),
	)
	return [...methods].join(', ')
}

/**
 * The accepted bodies of one request line, as the sentence a refusal names them
 * with. The published contract and the runtime's 4xx read the same list, which
 * is the property that makes publishing it worth anything.
 */
export function acceptedBodies(
	contract: PageContract,
	request: string,
): string {
	const bodies = contract.endpoints
		.filter((e) => e.request === request && e.body)
		.map((e) => `${e.body} to ${e.purpose}`)
	if (bodies.length === 0) return `\`${request}\` is not served.`
	return `\`${request}\` accepts ${bodies.join('; or ')}.`
}
