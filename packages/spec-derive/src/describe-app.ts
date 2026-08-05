/**
 * Description → app blueprint — the compiler behind
 * `maxstack start "<description>"`.
 *
 * The first sixty seconds cannot be "it starts empty, so there's nothing to
 * see yet". This turns one sentence into a small set of entities with typed
 * fields, which the CLI compiles into the exact same `data.addEntity` /
 * `page.addPage` ops `add-entity --with-page` emits. It authors *nothing* the
 * op vocabulary can't already express: the blueprint is sugar over the field
 * DSL, not a second way to write a spec.
 *
 * Two paths, one shape:
 *
 *   - **Keyed** — the AI port (`selectAiClient`) is asked for the blueprint as
 *     JSON. Its answer is normalized and validated here; anything unusable
 *     falls back rather than failing the command, because a half-scaffolded
 *     project a user can't re-run is worse than a plainer starting spec.
 *   - **Keyless / `MOCK_AI=1`** — {@link blueprintFromDescription}, a pure
 *     function of the description string. Same input, byte-identical output,
 *     which is the property that lets `start` be gated in CI at all.
 *
 * The mock generator (`mocks/openai.ts`, key `app-blueprint`) returns the
 * heuristic's own JSON, so the `MOCK_AI` path still exercises the real parse +
 * normalize + validate code the keyed path depends on — a mock that bypassed
 * them would let a parser regression ship green.
 */

import type { AiClient } from './ai.ts'

// ===========================================================================
// The blueprint
// ===========================================================================

/** One entity in a starting blueprint. `fields` are field-DSL strings
 * (`title:text!`, `status:enum(todo,done)`, `project:->e-project`) — the same
 * grammar `maxstack add-entity --field` takes, so the CLI compiles a blueprint
 * with the parser it already ships rather than a second one. */
export interface BlueprintEntity {
	/** Identifier-shaped, lowercase-initial: becomes `e-<slug>` and `/<slug>`. */
	slug: string
	/** Display name for the entity and its default list page. */
	name: string
	fields: string[]
}

/** A starting app: a title plus the entities to land, in dependency order
 * (a referenced entity always precedes the entity referencing it). */
export interface AppBlueprint {
	/** Human-facing project title (`Bug Tracker`). */
	title: string
	entities: BlueprintEntity[]
}

/** Where a blueprint came from — reported to the user, never guessed at. */
export type BlueprintSource = 'ai' | 'heuristic'

export interface DescribedApp {
	blueprint: AppBlueprint
	source: BlueprintSource
	/** Why the AI answer was not used, when `source` fell back to `heuristic`
	 * despite a client being available. Absent on the ordinary keyless path. */
	fallbackReason?: string
}

/** Hard caps. A starting spec is a starting point: a blueprint that lands
 * twelve entities is not reviewable in the first sixty seconds, which is the
 * whole point of the command. */
const MAX_ENTITIES = 5
const MAX_FIELDS = 8

/**
 * The scalar type aliases the field DSL accepts, mirrored from
 * `apps/maxstack/src/lib/field-dsl.ts`'s `TYPE_ALIASES` (the authority — this
 * package cannot import from an app). Enumerated rather than matched as
 * `[a-z]+`, because a model that invents `status:pending` must be rejected
 * *here*, before the CLI hands it to `parseField` and throws mid-scaffold.
 * `apps/maxstack/src/lib/blueprint.test.ts` asserts the two lists agree.
 */
export const BLUEPRINT_TYPE_ALIASES = [
	'text',
	'string',
	'str',
	'number',
	'num',
	'int',
	'integer',
	'float',
	'bool',
	'boolean',
	'date',
	'datetime',
	'timestamp',
	'json',
	'object',
] as const

/** The field-DSL grammar as a recognizer, so an unusable model answer is
 * rejected before anything is written to disk. */
const FIELD_RE = new RegExp(
	`^[a-z][a-zA-Z0-9]*:(?:enum\\([^()]+\\)|(?:ref:|->)e-[a-z][a-zA-Z0-9]*|(?:${BLUEPRINT_TYPE_ALIASES.join('|')}))!?$`,
)
const SLUG_RE = /^[a-z][a-zA-Z0-9]*$/

// ===========================================================================
// The keyed path
// ===========================================================================

/** The instruction handed to the model. Names the grammar explicitly, because
 * an invented type or a dangling reference is a rejected blueprint and a
 * silent downgrade to the heuristic. */
export function buildBlueprintPrompt(description: string): string {
	return [
		'Design the starting data model for a small web app from the description below.',
		'',
		'Respond with ONLY one JSON object — no prose, no markdown fences:',
		'{"title": "Bug Tracker", "entities": [{"slug": "bug", "name": "Bug", "fields": ["title:text!", "status:enum(open,closed)"]}]}',
		'',
		'Rules:',
		`- Between 1 and ${MAX_ENTITIES} entities, each with 2 to ${MAX_FIELDS} fields.`,
		'- "slug" is a singular lowercase identifier (camelCase allowed): bug, lineItem. Never plural.',
		'- Each field is a string "name:type", optionally suffixed "!" to mark it required.',
		'- Types are exactly: text, number, bool, date, json, enum(a,b,c), or ->e-<slug> for a reference to another entity in this list.',
		'- Field names are lowercase identifiers (camelCase allowed): title, dueOn.',
		'- Give every entity a required human-readable first field (usually title:text! or name:text!).',
		'- Order entities so a referenced entity appears before the entity referencing it.',
		'- Model only what the description states or clearly implies. Do not invent auth, billing, or audit entities.',
		'',
		'Description:',
		'"""',
		description,
		'"""',
	].join('\n')
}

/**
 * Compile a description into a starting blueprint. Uses `ai` when one is
 * supplied, falling back to the deterministic heuristic when the model is
 * unavailable or answers with something the op vocabulary can't express.
 */
export async function describeApp(opts: {
	description: string
	ai?: AiClient
}): Promise<DescribedApp> {
	const heuristic = blueprintFromDescription(opts.description)
	if (!opts.ai) return { blueprint: heuristic, source: 'heuristic' }

	try {
		const text = await opts.ai.complete({
			generator: 'app-blueprint',
			key: 'start',
			prompt: buildBlueprintPrompt(opts.description),
		})
		return { blueprint: normalizeBlueprint(parseBlueprint(text)), source: 'ai' }
	} catch (err) {
		return {
			blueprint: heuristic,
			source: 'heuristic',
			fallbackReason: err instanceof Error ? err.message : String(err),
		}
	}
}

/** Extract the blueprint object from a completion — exact parse first, then the
 * outermost `{…}` span, because models still chat around their JSON. */
export function parseBlueprint(text: string): unknown {
	const trimmed = text.trim()
	try {
		return JSON.parse(trimmed)
	} catch {
		// fall through to the span scan
	}
	const start = trimmed.indexOf('{')
	const end = trimmed.lastIndexOf('}')
	if (start < 0 || end <= start) {
		throw new Error('blueprint: response contained no JSON object')
	}
	return JSON.parse(trimmed.slice(start, end + 1))
}

/**
 * Coerce an untrusted blueprint into one the op layer will accept, dropping
 * what it can and throwing only when nothing usable is left. Drops rather than
 * repairs: a silently "fixed" field is a spec row the user never asked for,
 * and this lands in *their* project.
 */
export function normalizeBlueprint(raw: unknown): AppBlueprint {
	if (!raw || typeof raw !== 'object') {
		throw new Error('blueprint: expected a JSON object')
	}
	const obj = raw as Record<string, unknown>
	const rawEntities = Array.isArray(obj.entities) ? obj.entities : []

	// Two passes: collect the surviving slugs first, so a reference to an entity
	// that was itself dropped can be dropped too rather than landing dangling.
	const claimed: { slug: string; name: string; fields: unknown }[] = []
	const seenSlugs = new Set<string>()
	for (const entry of rawEntities) {
		if (!entry || typeof entry !== 'object') continue
		const e = entry as Record<string, unknown>
		const slug = typeof e.slug === 'string' ? e.slug.trim() : ''
		if (!SLUG_RE.test(slug) || seenSlugs.has(slug)) continue
		seenSlugs.add(slug)
		const name =
			typeof e.name === 'string' && e.name.trim()
				? e.name.trim()
				: titleCase(slug)
		claimed.push({ slug, name, fields: e.fields })
		if (claimed.length >= MAX_ENTITIES) break
	}

	const entities: BlueprintEntity[] = []
	for (const c of claimed) {
		const fields = normalizeFields(c.fields, seenSlugs)
		if (fields.length === 0) continue
		entities.push({ slug: c.slug, name: c.name, fields })
	}
	if (entities.length === 0) {
		throw new Error('blueprint: no entity survived validation')
	}

	const first = entities[0]
	const title =
		typeof obj.title === 'string' && obj.title.trim()
			? obj.title.trim()
			: // `entities` is non-empty by the check above; naming the fallback keeps
				// that obvious without an assertion.
				titleCase(first ? first.slug : 'app')
	return { title, entities }
}

/** Keep the field strings the DSL accepts, in order, deduped by name, capped —
 * and only those references that resolve inside this blueprint. */
function normalizeFields(raw: unknown, slugs: ReadonlySet<string>): string[] {
	if (!Array.isArray(raw)) return []
	const out: string[] = []
	const seen = new Set<string>()
	for (const entry of raw) {
		if (typeof entry !== 'string') continue
		const spec = entry.trim()
		if (!FIELD_RE.test(spec)) continue
		const name = spec.slice(0, spec.indexOf(':'))
		if (seen.has(name)) continue
		const target = /(?:ref:|->)e-([a-zA-Z0-9]+)!?$/.exec(spec)?.[1]
		if (target !== undefined && !slugs.has(target)) continue
		seen.add(name)
		out.push(spec)
		if (out.length >= MAX_FIELDS) break
	}
	return out
}

// ===========================================================================
// The deterministic heuristic
// ===========================================================================

/**
 * A domain the lexicon recognizes. `keywords` are matched as whole words
 * against the lowercased description; the highest-scoring domain wins, ties
 * broken by declaration order so the function stays a pure map from string to
 * blueprint.
 */
interface Domain {
	keywords: string[]
	blueprint: AppBlueprint
}

/**
 * The starting-domain lexicon. Deliberately small and drawn from the shapes
 * `docs/app-prompts/` already covers — this is a *starting point a human then
 * reviews*, not a claim to have understood the request. When nothing matches,
 * {@link genericBlueprint} extracts nouns instead, which is the honest
 * behavior: a plain entity named after what the user actually said.
 */
const DOMAINS: Domain[] = [
	{
		keywords: ['bug', 'bugs', 'issue', 'issues', 'defect', 'ticket', 'tickets'],
		blueprint: {
			title: 'Bug Tracker',
			entities: [
				{
					slug: 'project',
					name: 'Project',
					fields: ['name:text!', 'description:text'],
				},
				{
					slug: 'bug',
					name: 'Bug',
					fields: [
						'title:text!',
						'details:text',
						'status:enum(open,inProgress,closed)',
						'severity:enum(low,medium,high)',
						'reportedOn:date',
						'project:->e-project',
					],
				},
			],
		},
	},
	{
		keywords: ['task', 'tasks', 'todo', 'todos', 'kanban', 'backlog'],
		blueprint: {
			title: 'Task Tracker',
			entities: [
				{
					slug: 'project',
					name: 'Project',
					fields: ['name:text!', 'notes:text'],
				},
				{
					slug: 'task',
					name: 'Task',
					fields: [
						'title:text!',
						'notes:text',
						'status:enum(todo,doing,done)',
						'priority:enum(low,medium,high)',
						'dueOn:date',
						'project:->e-project',
					],
				},
			],
		},
	},
	{
		keywords: [
			'crm',
			'contact',
			'contacts',
			'lead',
			'leads',
			'customer',
			'customers',
			'client',
			'clients',
		],
		blueprint: {
			title: 'Contact Manager',
			entities: [
				{
					slug: 'company',
					name: 'Company',
					fields: ['name:text!', 'website:text', 'industry:text'],
				},
				{
					slug: 'contact',
					name: 'Contact',
					fields: [
						'name:text!',
						'email:text',
						'phone:text',
						'stage:enum(new,active,dormant)',
						'company:->e-company',
					],
				},
				{
					slug: 'interaction',
					name: 'Interaction',
					fields: [
						'summary:text!',
						'happenedOn:date',
						'channel:enum(email,call,meeting)',
						'contact:->e-contact',
					],
				},
			],
		},
	},
	{
		keywords: ['recipe', 'recipes', 'meal', 'meals', 'cooking', 'menu'],
		blueprint: {
			title: 'Recipe Manager',
			entities: [
				{
					slug: 'recipe',
					name: 'Recipe',
					fields: [
						'title:text!',
						'instructions:text',
						'servings:number',
						'minutes:number',
						'course:enum(breakfast,lunch,dinner,dessert)',
					],
				},
				{
					slug: 'ingredient',
					name: 'Ingredient',
					fields: ['name:text!', 'quantity:text', 'recipe:->e-recipe'],
				},
			],
		},
	},
	{
		keywords: ['invoice', 'invoices', 'billing', 'freelance', 'invoicing'],
		blueprint: {
			title: 'Invoicing',
			entities: [
				{
					slug: 'client',
					name: 'Client',
					fields: ['name:text!', 'email:text', 'address:text'],
				},
				{
					slug: 'invoice',
					name: 'Invoice',
					fields: [
						'reference:text!',
						'issuedOn:date',
						'dueOn:date',
						'status:enum(draft,sent,paid,overdue)',
						'client:->e-client',
					],
				},
				{
					slug: 'lineItem',
					name: 'Line Item',
					fields: [
						'description:text!',
						'quantity:number',
						'unitPrice:number',
						'invoice:->e-invoice',
					],
				},
			],
		},
	},
	{
		keywords: [
			'inventory',
			'stock',
			'warehouse',
			'asset',
			'assets',
			'equipment',
		],
		blueprint: {
			title: 'Inventory',
			entities: [
				{
					slug: 'location',
					name: 'Location',
					fields: ['name:text!', 'notes:text'],
				},
				{
					slug: 'item',
					name: 'Item',
					fields: [
						'name:text!',
						'description:text',
						'quantity:number',
						'condition:enum(new,good,worn,broken)',
						'acquiredOn:date',
						'location:->e-location',
					],
				},
			],
		},
	},
	{
		keywords: ['event', 'events', 'rsvp', 'conference', 'meetup', 'wedding'],
		blueprint: {
			title: 'Events',
			entities: [
				{
					slug: 'event',
					name: 'Event',
					fields: [
						'title:text!',
						'description:text',
						'startsOn:date',
						'venue:text',
						'capacity:number',
					],
				},
				{
					slug: 'guest',
					name: 'Guest',
					fields: [
						'name:text!',
						'email:text',
						'response:enum(invited,yes,no,maybe)',
						'event:->e-event',
					],
				},
			],
		},
	},
	{
		keywords: ['book', 'books', 'reading', 'library', 'author', 'authors'],
		blueprint: {
			title: 'Reading Tracker',
			entities: [
				{ slug: 'author', name: 'Author', fields: ['name:text!', 'bio:text'] },
				{
					slug: 'book',
					name: 'Book',
					fields: [
						'title:text!',
						'status:enum(toRead,reading,finished)',
						'rating:number',
						'finishedOn:date',
						'author:->e-author',
					],
				},
			],
		},
	},
	{
		keywords: ['workout', 'workouts', 'exercise', 'fitness', 'training', 'gym'],
		blueprint: {
			title: 'Workout Tracker',
			entities: [
				{
					slug: 'exercise',
					name: 'Exercise',
					fields: [
						'name:text!',
						'muscleGroup:enum(push,pull,legs,core)',
						'notes:text',
					],
				},
				{
					slug: 'workout',
					name: 'Workout',
					fields: [
						'title:text!',
						'performedOn:date',
						'minutes:number',
						'notes:text',
					],
				},
				{
					slug: 'set',
					name: 'Set',
					fields: [
						'label:text!',
						'reps:number',
						'weight:number',
						'workout:->e-workout',
						'exercise:->e-exercise',
					],
				},
			],
		},
	},
	{
		keywords: [
			'expense',
			'expenses',
			'budget',
			'spending',
			'transaction',
			'transactions',
		],
		blueprint: {
			title: 'Expenses',
			entities: [
				{
					slug: 'category',
					name: 'Category',
					fields: ['name:text!', 'notes:text'],
				},
				{
					slug: 'expense',
					name: 'Expense',
					fields: [
						'description:text!',
						'amount:number',
						'spentOn:date',
						'method:enum(card,cash,transfer)',
						'category:->e-category',
					],
				},
			],
		},
	},
	{
		keywords: ['habit', 'habits', 'streak', 'routine', 'routines'],
		blueprint: {
			title: 'Habit Tracker',
			entities: [
				{
					slug: 'habit',
					name: 'Habit',
					fields: [
						'name:text!',
						'cadence:enum(daily,weekly,monthly)',
						'notes:text',
					],
				},
				{
					slug: 'checkIn',
					name: 'Check-In',
					fields: [
						'label:text!',
						'happenedOn:date',
						'done:bool',
						'habit:->e-habit',
					],
				},
			],
		},
	},
	{
		keywords: [
			'job',
			'jobs',
			'application',
			'applications',
			'candidate',
			'hiring',
			'applicant',
		],
		blueprint: {
			title: 'Application Tracker',
			entities: [
				{
					slug: 'company',
					name: 'Company',
					fields: ['name:text!', 'website:text'],
				},
				{
					slug: 'application',
					name: 'Application',
					fields: [
						'role:text!',
						'stage:enum(applied,screening,interview,offer,rejected)',
						'appliedOn:date',
						'notes:text',
						'company:->e-company',
					],
				},
			],
		},
	},
	{
		keywords: [
			'patient',
			'patients',
			'clinic',
			'appointment',
			'appointments',
			'doctor',
		],
		blueprint: {
			title: 'Appointments',
			entities: [
				{
					slug: 'patient',
					name: 'Patient',
					fields: ['name:text!', 'email:text', 'phone:text', 'notes:text'],
				},
				{
					slug: 'appointment',
					name: 'Appointment',
					fields: [
						'reason:text!',
						'scheduledOn:date',
						'status:enum(scheduled,seen,cancelled)',
						'patient:->e-patient',
					],
				},
			],
		},
	},
	{
		keywords: [
			'order',
			'orders',
			'shop',
			'store',
			'product',
			'products',
			'ecommerce',
		],
		blueprint: {
			title: 'Orders',
			entities: [
				{
					slug: 'product',
					name: 'Product',
					fields: [
						'name:text!',
						'description:text',
						'price:number',
						'inStock:bool',
					],
				},
				{
					slug: 'order',
					name: 'Order',
					fields: [
						'reference:text!',
						'customerName:text',
						'placedOn:date',
						'status:enum(new,packed,shipped,delivered)',
						'product:->e-product',
					],
				},
			],
		},
	},
	{
		keywords: [
			'course',
			'courses',
			'student',
			'students',
			'lesson',
			'lessons',
			'class',
			'school',
		],
		blueprint: {
			title: 'Courses',
			entities: [
				{
					slug: 'course',
					name: 'Course',
					fields: ['title:text!', 'description:text', 'startsOn:date'],
				},
				{
					slug: 'student',
					name: 'Student',
					fields: ['name:text!', 'email:text'],
				},
				{
					slug: 'enrollment',
					name: 'Enrollment',
					fields: [
						'label:text!',
						'enrolledOn:date',
						'status:enum(active,completed,dropped)',
						'course:->e-course',
						'student:->e-student',
					],
				},
			],
		},
	},
]

/**
 * The deterministic description → blueprint compiler: a pure function of the
 * string, which is what makes `maxstack start` gateable in CI and what
 * `MOCK_AI=1` returns. Matches the description against the domain lexicon and
 * falls back to naming an entity after the nouns the user actually used.
 */
export function blueprintFromDescription(description: string): AppBlueprint {
	const words = wordsOf(description)
	const bag = new Set(words)

	let best: { domain: Domain; score: number } | null = null
	for (const domain of DOMAINS) {
		const score = domain.keywords.reduce((n, k) => n + (bag.has(k) ? 1 : 0), 0)
		// Strictly greater: ties keep the earlier declaration, so the result is a
		// function of the lexicon's order rather than of iteration accidents.
		if (score > 0 && (!best || score > best.score)) best = { domain, score }
	}
	if (best) return withTitle(best.domain.blueprint, description)

	return genericBlueprint(words, description)
}

/**
 * No domain matched: build one entity named after the description's most
 * likely subject noun, with the fields every list-shaped record wants. Honest
 * about what it is — a starting point named after what the user said, not a
 * pretense of understanding.
 */
function genericBlueprint(words: string[], description: string): AppBlueprint {
	const noun = words.find((w) => !STOPWORDS.has(w) && w.length > 2)
	const slug = noun ? singularize(camelSlug(noun)) : 'item'
	const safe = SLUG_RE.test(slug) ? slug : 'item'
	return {
		title: titleFromDescription(description) ?? titleCase(safe),
		entities: [
			{
				slug: safe,
				name: titleCase(safe),
				fields: [
					'title:text!',
					'notes:text',
					'status:enum(new,active,done)',
					'dueOn:date',
				],
			},
		],
	}
}

/**
 * Prefer a title the user's own words support over the lexicon's generic one,
 * so `start "a tracker for my sourdough starters"` isn't titled "Inventory".
 *
 * Two words minimum. Stopword-stripping "a bug tracker for small teams" leaves
 * the single word "bug", and titling the app *Bug* (in a directory called
 * `bug/`) is worse than the lexicon's own "Bug Tracker" — observed on the first
 * real run of the command.
 */
function withTitle(blueprint: AppBlueprint, description: string): AppBlueprint {
	const title = titleFromDescription(description)
	if (!title || title.split(' ').length < 2) return blueprint
	return { ...blueprint, title }
}

/** A display title from the description's first few meaningful words, or
 * `null` when the description is too thin to derive one from. */
function titleFromDescription(description: string): string | null {
	const kept = wordsOf(description)
		.filter((w) => !STOPWORDS.has(w))
		.slice(0, 4)
	if (kept.length === 0) return null
	return kept.map(titleCase).join(' ')
}

/** Lowercase alphanumeric words, in order. */
function wordsOf(text: string): string[] {
	return text.toLowerCase().match(/[a-z0-9]+/g) ?? []
}

const STOPWORDS = new Set([
	'a',
	'an',
	'the',
	'my',
	'our',
	'his',
	'her',
	'their',
	'its',
	'for',
	'of',
	'to',
	'and',
	'or',
	'with',
	'without',
	'app',
	'application',
	'site',
	'tool',
	'simple',
	'small',
	'basic',
	'little',
	'quick',
	'nice',
	'build',
	'make',
	'create',
	'want',
	'need',
	'like',
	'that',
	'this',
	'these',
	'those',
	'me',
	'i',
	'we',
	'us',
	'you',
	'is',
	'are',
	'be',
	'can',
	'so',
	'in',
	'on',
	'at',
	'by',
	'from',
	'it',
	'them',
	'some',
	'any',
	'all',
	'manage',
	'track',
	'tracker',
	'tracking',
	'manager',
	'system',
	'team',
	'teams',
	'where',
	'which',
	'who',
	'what',
	'when',
	'about',
	// Weak subject nouns: grammatically the head of the phrase, but never the
	// thing being modeled — "a place to log sightings" is about sightings.
	'place',
	'way',
	'thing',
	'things',
	'stuff',
	'somewhere',
	'something',
	'page',
	'dashboard',
	'database',
	'db',
])

/** `line-items` → `lineItems`; keeps the identifier shape the DSL requires. */
function camelSlug(word: string): string {
	const parts = word.split(/[^a-zA-Z0-9]+/).filter(Boolean)
	const [head, ...rest] = parts
	if (!head) return ''
	return (
		head.toLowerCase() +
		rest
			.map((p) => p.charAt(0).toUpperCase() + p.slice(1).toLowerCase())
			.join('')
	)
}

/** Enough English plurals for entity names, and no more: an entity is named in
 * the singular, and a wrong guess here costs a rename, not correctness. */
function singularize(word: string): string {
	if (/(ss|us|is)$/.test(word)) return word
	if (/ies$/.test(word)) return `${word.slice(0, -3)}y`
	if (/(ch|sh|x|z|s)es$/.test(word)) return word.slice(0, -2)
	if (/s$/.test(word)) return word.slice(0, -1)
	return word
}

/** `bug` → `Bug`, `lineItem` → `Line Item`. */
export function titleCase(slug: string): string {
	const spaced = slug.replace(/([a-z0-9])([A-Z])/g, '$1 $2')
	return spaced.charAt(0).toUpperCase() + spaced.slice(1)
}

/** A kebab-case project directory name for a blueprint title. */
export function projectSlug(title: string): string {
	return (
		title
			.toLowerCase()
			.trim()
			.replace(/[^a-z0-9]+/g, '-')
			.replace(/^-+|-+$/g, '') || 'maxstack-app'
	)
}
