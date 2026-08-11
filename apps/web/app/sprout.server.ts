/**
 * Server-only Sprout wiring for the admin app.
 *
 * Declares the resources once, materializes a store, and hands routes an
 * `OpContext`. Phase 0 runs the demo schema on an in-memory pglite database
 * (the same store the core e2e tests use); a project's real `sprout.config`
 * + Postgres store slot in here later without touching the routes.
 *
 * Auth (task 22) is better-auth: the request's *session* is the source of the
 * current user and `user.role` drives RBAC. `resolveUser` reads the session
 * first; a dev fallback (`x-maxstack-role` header, else a default admin) keeps
 * the local admin usable and unit tests header-driven, and is switched off by
 * `MAXSTACK_AUTH_STRICT=1` so a real deployment denies anonymous requests.
 * Denial needs a rule to deny against: `authorize()` is open-by-default, so
 * project spec entities register with `AUTHENTICATED_WRITES` when the auth
 * bundle is installed — strict mode then actually 403s anonymous
 * writes instead of waving them through.
 */

import {
	AUTHENTICATED_WRITES,
	applyComputed,
	type ComputedShape,
	createAccessContext,
	createSpecStore,
	type InverseReference,
	inverseReferences,
	opCount,
	opGetMany,
	opList,
	type ReferenceMap,
	type ResourceCapabilities,
	ResourceRegistry,
	type RollupResultRow,
	type RollupShape,
	type Row,
	registerSpecEntities,
	relatedOrder,
	resolveReferences,
	resolveRollups,
	resourceCapabilities,
	type SpecEntityShape,
	type SproutResource,
	type SproutStore,
	type SproutUser,
	scopeGrants,
} from '@maxstack/core'
// The DB-driver selection (pglite + postgres.js) is a server-only subpath so it
// never lands in a client bundle — see the note in core's `sprout/index.ts`.
import {
	createBackend,
	pgliteBackend,
	resolveBackendConfig,
	type StoreBackend,
} from '@maxstack/core/backend'
import {
	article,
	author,
	comment,
	createDemoDb,
	tag,
	task,
} from '@maxstack/core/demo'
import {
	API_KEYS_DDL,
	type ApiKeyScope,
	ApiKeyService,
} from '@maxstack/features/api-keys'
import {
	type AuditReader,
	type AuditSink,
	createMemoryAuditSink,
} from '@maxstack/features/audit'
import {
	AUTH_DDL,
	type Auth,
	user as authUserTable,
	createAuth,
	resolveSproutUser,
} from '@maxstack/features/auth'
import {
	BUNDLES,
	type Bundle,
	describeCatalog,
	type InstalledBundle,
	previewInstall,
	seedBundles,
} from '@maxstack/features/bundle'
import { schedulePurgeJob } from '@maxstack/features/compliance'
import {
	type DemoSeedManifest,
	emptyManifest,
	clearDemoData as genericClearDemoData,
	seedDemoData as genericSeedDemoData,
	hasAnyData,
	manifestRowCount,
	mergeManifest,
	readDemoManifest,
	removeDemoManifest,
	writeDemoManifest,
} from '@maxstack/features/demo-mode'
import {
	createDrizzleJobStore,
	JOBS_DDL,
	JobQueue,
	registerScheduleHandlers,
	Scheduler,
	scheduleInterval,
	schedulesOf,
} from '@maxstack/features/jobs'
import {
	DIGEST_SWEEP_JOB_TYPE,
	registerDigestJobs,
} from '@maxstack/features/notifications'
import {
	registerSourceHandlers,
	writeTriggersEnrichment,
} from '@maxstack/features/sources'
import { derivativeKey } from '@maxstack/features/storage'
import { type WebhookEvent, WebhookService } from '@maxstack/features/webhooks'
import {
	createFileSpecStore,
	createInMemorySpecStore,
	defaultCheckRunner,
	defaultGeneratorRunner,
	type PlatformContext,
	type SpecStore,
} from '@maxstack/mcp'
import {
	applyOp,
	MAX_FANOUT_ORGS,
	manual,
	newSpecSystem,
	type OpId,
	type ScheduleRunAs,
	type SpecSystem,
	suggested,
} from '@maxstack/spec'
import { tasklyPRD } from '@maxstack/spec/fixtures'
import {
	type FileResolution,
	isUrlValue,
	type ListActionDescriptor,
} from '@maxstack/ui'
import { eq } from 'drizzle-orm'
import {
	OWNED_SCHEDULE_HANDLERS,
	OWNED_SOURCE_REFINERS,
} from '~/owned.generated'
import { absolutizeDataDir, resolveSpecPath } from './data-dir.server'
import type { McpContext } from './mcp.server'
import {
	groundedEntityShapes,
	missingReferenceBundles,
	schemaFingerprint,
} from './spec-sprout'
import { signedFileUrl } from './storage.server'

export interface WebSprout {
	registry: ResourceRegistry
	store: SproutStore
	/** The store backend (pglite or Postgres) — auth and re-syncs share it. */
	backend: StoreBackend
	auth: Auth
	/** Whether the project has the `auth` bundle installed. When true, spec
	 * entities register with `AUTHENTICATED_WRITES` and the REST API's write
	 * routes reject the anonymous dev fallback. */
	authInstalled: boolean
	/**
	 * Derived values per resource, keyed by resource name. Retained
	 * off the grounding pass because the read path needs them and the registry
	 * cannot carry them — a derived value has no column, so there is nothing in
	 * the drizzle table or the introspection for it to hang off.
	 *
	 * Absent for the demo runtime, which has no spec.
	 */
	derived?: Map<string, { computed: ComputedShape[]; rollups: RollupShape[] }>
}

/**
 * Materialize the better-auth tables on the backend and build the instance. The
 * auth tables live in the *same* database as the app data (one pglite file, one
 * Postgres schema), so sessions and rows share a transactional store — and this
 * is backend-agnostic, which is why auth works unchanged on Postgres. Seeds a
 * dev admin (`admin@maxstack.dev` / `maxstack`) on first boot so the local
 * admin UI has a real, sign-in-able owner instead of a header stand-in.
 */
async function buildAuth(backend: StoreBackend): Promise<Auth> {
	await backend.exec(AUTH_DDL)
	const auth = createAuth({ db: backend.db })
	await seedAuthAdmin(backend, auth)
	return auth
}

async function seedAuthAdmin(backend: StoreBackend, auth: Auth): Promise<void> {
	try {
		await auth.api.signUpEmail({
			body: {
				email: 'admin@maxstack.dev',
				password: 'maxstack',
				name: 'Dev Admin',
			},
		})
	} catch {
		// Email already registered — the seed owner exists; nothing to do.
		return
	}
	// `role` is input:false, so sign-up lands 'member' — elevate the seed owner.
	await backend.exec(
		`UPDATE "user" SET role = 'admin' WHERE email = 'admin@maxstack.dev';`,
	)
}

function buildRegistry(): ResourceRegistry {
	const registry = new ResourceRegistry()
	registry.register(author, {
		group: 'Content',
		icon: '✍️',
		titleField: 'name',
		access: {
			read: 'public',
			create: 'authenticated',
			update: 'authenticated',
		},
	})
	registry.register(task, {
		group: 'Content',
		icon: '✅',
		titleField: 'title',
		access: {
			read: 'public',
			create: 'authenticated',
			update: 'authenticated',
			delete: 'admin',
		},
	})
	// The rich-input showcase (task 39): a markdown body, an image upload, and a
	// password all render the right editor from inference alone.
	registry.register(article, {
		group: 'Content',
		icon: '📝',
		titleField: 'title',
		access: {
			read: 'public',
			create: 'authenticated',
			update: 'authenticated',
			delete: 'admin',
		},
	})
	// The array-reference showcase (task 38): `article.tags` holds tag ids,
	// rendered as chips and edited as a multi-select; `comment` gives an article
	// a child count shown without loading the comments.
	registry.register(tag, {
		group: 'Content',
		icon: '🏷️',
		titleField: 'name',
		access: {
			read: 'public',
			create: 'authenticated',
			update: 'authenticated',
		},
	})
	// Soft-delete showcase (`ResourceConfig.softDelete`): a moderated
	// "delete" sets `deletedAt` instead of removing the row, so reads exclude it
	// by default but it's recoverable within the retention window via
	// `/comments/trash` (a small admin list + restore affordance) until the
	// scheduled purge job (`@maxstack/features/compliance`) hard-deletes it.
	registry.register(comment, {
		group: 'Content',
		icon: '💬',
		titleField: 'body',
		access: {
			read: 'public',
			create: 'authenticated',
			update: 'authenticated',
		},
		softDelete: true,
	})
	return registry
}

async function seed(sprout: WebSprout): Promise<void> {
	const authors = await sprout.store.list('author', { limit: 1 })
	if (authors.length > 0) return
	const ada = await sprout.store.create('author', { name: 'Ada Lovelace' })
	await sprout.store.create('task', {
		title: 'Wire Sprout into the admin',
		priority: 'high',
		authorId: ada.id,
	})
	await sprout.store.create('task', {
		title: 'Expose the MCP transport',
		priority: 'medium',
		authorId: ada.id,
	})
	const ecosystem = await sprout.store.create('tag', { name: 'Ecosystem' })
	const dx = await sprout.store.create('tag', { name: 'DX' })
	await sprout.store.create('tag', { name: 'Internals' })
	const article = await sprout.store.create('article', {
		title: 'Rich inputs, zero config',
		body: '# Rich inputs\n\nThis body edits in a **markdown** editor and displays via `<MarkdownField>` — inferred from one `markdown: true` flag.',
		rating: 4,
		brandColor: '#4f46e5',
		// An array reference: chips resolve to tag names, no N+1 (task 38).
		tags: [ecosystem.id, dx.id],
	})
	// Comments exist only to be counted, not listed (`<ReferenceManyCount>`).
	await sprout.store.create('comment', {
		articleId: article.id,
		body: 'The inferred markdown editor is a lovely touch.',
	})
	await sprout.store.create('comment', {
		articleId: article.id,
		body: 'Does the array reference batch its resolves?',
	})
}

async function init(): Promise<WebSprout> {
	const registry = buildRegistry()
	const { store, client } = await createDemoDb(registry)
	// Wrap the demo client as a backend so auth shares its in-memory database.
	const backend = pgliteBackend(client)
	const auth = await buildAuth(backend)
	// Demo mode has no project spec entities, so no AUTHENTICATED_WRITES rule and
	// nothing for the write gate to protect — treat auth as not "installed".
	const sprout: WebSprout = {
		registry,
		store,
		backend,
		auth,
		authInstalled: false,
	}
	await seed(sprout)
	return sprout
}

// ---------------------------------------------------------------------------
// Project mode — `MAXSTACK_DATA_DIR` opens a real project: the registry is
// grounded from *that project's spec* (accepted-else-all) instead of the demo
// schema, and rows persist in the selected store backend. That backend is
// `DATABASE_URL` (a real Postgres server) when set, else on-disk pglite under
// `<dataDir>/db` — the same schema, store, and auth run over either (task 22).
// The spec is re-grounded per request (a cheap validated file read); the
// database only re-syncs — additive DDL on the same live backend — when the
// grounded schema's fingerprint actually changed (e.g. an accepted new field).
// ---------------------------------------------------------------------------

interface ProjectSprout extends WebSprout {
	fingerprint: string
}

const projectDataDir = (): string | null => {
	const configured = process.env.MAXSTACK_DATA_DIR?.trim()
	return configured ? absolutizeDataDir(configured) : null
}

async function groundProject(
	dataDir: string,
	current?: ProjectSprout,
): Promise<ProjectSprout> {
	const spec = await getPlatform().spec.load()
	const installed = await readInstalledBundleSlugs(dataDir)
	// Installed bundles shape the grounding (a `reference: 'e-user'` only wires
	// up when auth is present) and the registry (the read-only user resource),
	// so they are part of the schema identity the re-sync check compares.
	const shapes = groundedEntityShapes(spec, { installedBundles: installed })
	const fingerprint = `${schemaFingerprint(shapes)}|${installed.join(',')}`
	if (current && current.fingerprint === fingerprint) return current
	const registry = new ResourceRegistry()
	// Secure-by-default: with the auth bundle installed, spec-entity
	// writes require a session ('authenticated'); reads stay public. Without it
	// there is no way to log in, so entities stay open — warn loudly instead.
	registerSpecEntities(registry, shapes, {
		access: installed.includes('auth') ? AUTHENTICATED_WRITES : undefined,
	})
	registerAuthUserResource(registry, installed)
	warnIfOpenApi(installed, shapes.length)
	warnMissingReferenceBundles(spec, installed)
	// The backend is opened once (first grounding) and carried across re-syncs —
	// pglite holds an exclusive on-disk handle that must not be reopened, and a
	// Postgres pool is pointless to churn. Config: DATABASE_URL → Postgres.
	const backend =
		current?.backend ??
		(await createBackend(
			resolveBackendConfig({
				dir: `${dataDir}/db`,
				databaseUrl: process.env.DATABASE_URL,
			}),
		))
	const store = await createSpecStore(backend, registry, shapes)
	const auth = current?.auth ?? (await buildAuth(backend))
	await seedProjectBundles(installed, store)
	return {
		registry,
		store,
		backend,
		auth,
		authInstalled: installed.includes('auth'),
		derived: derivedByResource(shapes),
		fingerprint,
	}
}

/** Seed the project's installed bundles (idempotent) via the db-plugins engine. */
async function seedProjectBundles(
	installed: string[],
	store: SproutStore,
): Promise<void> {
	const bundles = installed
		.map((slug) => BUNDLES[slug])
		.filter((b): b is NonNullable<typeof b> => b != null)
	if (bundles.length) await seedBundles(store, bundles)
}

/** The installed bundles that actually carry demo rows — what "load demo
 * data" has to offer. Empty outside project mode. */
async function seededBundles(): Promise<Bundle[]> {
	const dataDir = projectDataDir()
	if (!dataDir) return []
	const installed = await readInstalledBundleSlugs(dataDir)
	return installed
		.map((slug) => BUNDLES[slug])
		.filter((b): b is NonNullable<typeof b> => b != null)
		.filter((b) => (b.runtime.seeds?.length ?? 0) > 0)
}

/** Whether the current project has any registered resource at all — gates the
 * onboarding wizard's / empty-state's "Load demo data" CTA. Bundle seeds are
 * used when a resource has them; every other resource still gets generic
 * sample rows (`genericSeedDemoData` below), so this is "is there anything to
 * seed", not "does a bundle happen to carry fixtures". */
export async function hasDemoData(): Promise<boolean> {
	if (!projectDataDir()) return false
	const { registry } = await getSprout()
	return registry.all().length > 0
}

/**
 * On-demand demo-data load: runs the same idempotent bundle-seed
 * mechanism boot already applies (`seedProjectBundles` above) for resources a
 * bundle ships fixtures for, then generically fills in sample rows — via
 * column introspection, `@maxstack/features/demo-mode` — for every other
 * resource that's still empty. Exposed as a user-triggered action for the
 * onboarding wizard / empty-state CTA. Idempotent: an entity that already has
 * rows (from either path) is left alone, so clicking it twice is a no-op.
 */
export async function seedDemoData(): Promise<{
	seeded: boolean
	resources: string[]
	/** Rows now tracked as demo data — cumulative, not just this call. */
	demoRows: number
}> {
	const bundles = await seededBundles()
	const { store, registry } = await getSprout()
	if (bundles.length) await seedBundles(store, bundles)
	const generic = await genericSeedDemoData({ registry, store })

	// Record which rows this created. Written *after* the rows
	// commit, so a crash mid-seed leaves rows the manifest doesn't claim —
	// untracked demo rows read as the user's own, which is the safe failure:
	// the opposite (claiming rows we never created) would let `--clear` delete
	// real data.
	const manifest = await recordSeededRows(generic.created)

	return {
		seeded: bundles.length > 0 || generic.seeded.length > 0,
		resources: generic.seeded,
		demoRows: manifestRowCount(manifest),
	}
}

/** Fold a seed's created ids into the project's demo manifest. Outside project
 * mode (no data dir) there is nowhere to write one, and nothing that reads it. */
async function recordSeededRows(
	created: Record<string, string[]>,
): Promise<DemoSeedManifest> {
	const dataDir = projectDataDir()
	if (!dataDir) return emptyManifest()
	const current = await readDemoManifest(dataDir)
	const next = mergeManifest(current, created, new Date().toISOString())
	if (manifestRowCount(next) > 0) await writeDemoManifest(dataDir, next)
	return next
}

/**
 * The demo rows currently tracked for this project — what the
 * in-app notice reports and what marks individual rows as sample data. Empty
 * outside project mode, and empty once `clearDemoData` has run.
 */
export async function demoSeedManifest(): Promise<DemoSeedManifest> {
	const dataDir = projectDataDir()
	if (!dataDir) return emptyManifest()
	return readDemoManifest(dataDir)
}

/**
 * Remove exactly the rows a previous seed created (closes #101).
 *
 * Runs in the server's own process on its own store handle, for the same reason
 * seeding does: a second process opening the single-writer store
 * would delete from a private view this server never sees, and report success.
 */
export async function clearDemoData(): Promise<{
	cleared: number
	resources: string[]
	missing: number
}> {
	const dataDir = projectDataDir()
	if (!dataDir) return { cleared: 0, resources: [], missing: 0 }
	const manifest = await readDemoManifest(dataDir)
	const { store, registry } = await getSprout()
	const result = await genericClearDemoData({
		registry,
		store,
		rows: manifest.rows,
	})
	// The manifest goes away wholesale: every id in it has now been deleted or
	// was already gone, so keeping a partial file would only mislead the notice.
	await removeDemoManifest(dataDir)
	const cleared = Object.values(result.deleted).reduce((n, c) => n + c, 0)
	return {
		cleared,
		resources: Object.keys(result.deleted),
		missing: result.missing,
	}
}

/**
 * A fresh install: project mode with every registered resource
 * still at zero rows. Drives the home page's onboarding wizard — it shows
 * only until the first row lands (demo-seeded or hand-entered), then gets out
 * of the way on its own, no separate "setup complete" marker to maintain.
 */
export async function isFreshProject(): Promise<boolean> {
	if (!projectDataDir()) return false
	const { registry, store } = await getSprout()
	return !(await hasAnyData(registry, store))
}

// Sessions are better-auth's to create and identity rows its to manage — the
// generic CRUD surface must never write them, whoever asks.
const NEVER = () => false

/**
 * With the auth bundle installed, expose its `user` table as a *read-only*
 * Sprout resource: a `reference: 'e-user'` field then gets a real
 * FK picker, `<ReferenceField>` resolution (title = name), and reverse counts,
 * because the referenced table is listable/fetchable like any other resource.
 * Reads require a session (the rows carry emails); writes are denied outright.
 * A spec entity that claims the `user` name wins — same shadowing rule as
 * grounding.
 */
function registerAuthUserResource(
	registry: ResourceRegistry,
	installed: string[],
): void {
	if (!installed.includes('auth') || registry.has('user')) return
	registry.register(authUserTable, {
		group: 'Auth',
		icon: '👤',
		titleField: 'name',
		access: {
			read: 'authenticated',
			create: NEVER,
			update: NEVER,
			delete: NEVER,
		},
	})
}

// One warning per process — grounding re-runs whenever the schema fingerprint
// changes, and the posture doesn't change with it.
let warnedOpenApi = false
let warnedMissingReferenceBundles = false

/** A spec that references a virtual entity (`e-user`) whose bundle is not
 * installed grounds those fields as plain columns — no picker, no resolution.
 * Say so once, with the fix. */
function warnMissingReferenceBundles(
	spec: SpecSystem,
	installed: string[],
): void {
	if (warnedMissingReferenceBundles) return
	const missing = missingReferenceBundles(spec, installed)
	if (missing.length === 0) return
	warnedMissingReferenceBundles = true
	console.warn(
		`⚠ maxstack: the spec references bundle-provided entities, but the ${missing.join(
			', ',
		)} bundle${missing.length > 1 ? 's are' : ' is'} not installed — those ` +
			'reference fields fall back to plain columns (no FK picker, no title ' +
			`resolution). Run \`maxstack add ${missing.join(' ')}\` to wire them up.`,
	)
}

/** The loud dev-time counterpart of `maxstack deploy`'s posture warning (issue
 * #32): without the auth bundle, no spec entity carries an access rule, and
 * `authorize()` is open-by-default — every REST/MCP write is anonymous-writable. */
function warnIfOpenApi(installed: string[], entityCount: number): void {
	if (warnedOpenApi || installed.includes('auth') || entityCount === 0) return
	warnedOpenApi = true
	console.warn(
		'⚠ maxstack: no auth bundle installed — the REST API is OPEN: anonymous ' +
			`requests can create/update/delete every spec entity (${entityCount}). ` +
			'Fine for a local data dir; do not deploy this. Run `maxstack add auth` ' +
			'to require a session for writes.',
	)
}

/** The bits of the project's `maxstack.json` the runtime reads at request time. */
interface RuntimeProjectConfig {
	bundles?: InstalledBundle[]
	cookieBanner?: string
}

/** Walk up from the data dir for the project's `maxstack.json`. `{}` when
 * there isn't one (demo mode, or a data dir outside a project). */
async function readProjectConfig(
	dataDir: string,
): Promise<RuntimeProjectConfig> {
	const { readFile } = await import('node:fs/promises')
	const { dirname, resolve } = await import('node:path')
	let dir = resolve(dataDir)
	for (let i = 0; i < 6; i++) {
		try {
			const raw = await readFile(resolve(dir, 'maxstack.json'), 'utf8')
			return JSON.parse(raw) as RuntimeProjectConfig
		} catch {
			// no maxstack.json here — try the parent
		}
		const parent = dirname(dir)
		if (parent === dir) break
		dir = parent
	}
	return {}
}

async function readInstalledBundleSlugs(dataDir: string): Promise<string[]> {
	const config = await readProjectConfig(dataDir)
	return (config.bundles ?? []).map((b) => b.slug)
}

/**
 * The install records this project has, for catalog discovery.
 * `[]` outside a project — "what could I add" is still a question worth
 * answering there, it just has nothing to annotate.
 */
export async function installedBundleRecords(): Promise<InstalledBundle[]> {
	const { resolveDataDir } = await import('./data-dir.server')
	const dataDir = resolveDataDir()
	if (!dataDir) return []
	return (await readProjectConfig(dataDir)).bundles ?? []
}

/**
 * Whether the cookie-consent banner has anything to disclose.
 *
 * The banner's own text is "this app uses cookies for sign-in and preferences",
 * and sign-in cookies only exist once the `auth` bundle is installed. A
 * single-user personal app on localhost with no sign-in sets nothing but
 * functional preference storage — there is no consent to collect, so nagging
 * for one on every visit is pure friction (and, on a page with no `/settings`,
 * a dead link).
 *
 * `maxstack.json`'s `cookieBanner` makes it a deliberate choice when the
 * default guess is wrong:
 *   - `"auto"` (default) — show it only when the `auth` bundle is installed.
 *   - `"always"` — always show it (analytics or embeds we can't see from here).
 *   - `"never"` — never show it.
 */
export function resolveCookieBanner(input: {
	/** `maxstack.json`'s `cookieBanner`, if set. Anything unrecognized is `auto`. */
	mode?: string
	/** Whether the `auth` bundle is installed — i.e. sign-in cookies exist. */
	authInstalled: boolean
}): boolean {
	if (input.mode === 'always') return true
	if (input.mode === 'never') return false
	return input.authInstalled
}

/**
 * Resolve the banner for the current request — the *wiring* around
 * {@link resolveCookieBanner}, and the half of issue #144 that #282 reported
 * back as server-path-dependent.
 *
 * Both dev paths run this exact module (`dev --owned` vendors `apps/web`;
 * the prebuilt runtime is a build of it) over the same absolute
 * `MAXSTACK_DATA_DIR`, so the answer must be a pure function of the project's
 * `maxstack.json` — never of anything the two paths can disagree about. It
 * reads `bundles` straight from that file rather than asking `getSprout()` for
 * `authInstalled`: identical value, same source of truth (`groundProject`
 * derives its own from the same read), but no store boot on the way. Booting
 * pglite + the auth DDL to answer "does this project have sign-in cookies"
 * made the banner depend on whether the store came up — and the root loader
 * swallows that failure into `cookieBanner: false`, so a store that boots on
 * one path and stumbles on the other is exactly a banner that appears on one
 * server and not the other, with no config change behind it.
 */
export async function showCookieBanner(): Promise<boolean> {
	const dataDir = projectDataDir()
	// Demo mode has no project config and no installed bundles.
	if (!dataDir) return resolveCookieBanner({ authInstalled: false })
	const config = await readProjectConfig(dataDir)
	return resolveCookieBanner({
		mode: config.cookieBanner,
		authInstalled: (config.bundles ?? []).some((b) => b.slug === 'auth'),
	})
}

// Module-singleton across dev HMR reloads: the demo pglite is in-memory, so a
// fresh instance per reload would drop seeded rows; the project client holds
// an exclusive on-disk pglite that must not be reopened concurrently.
const globalScope = globalThis as typeof globalThis & {
	__maxstackSprout?: Promise<WebSprout>
	__maxstackProjectSprout?: Promise<ProjectSprout>
}

export function getSprout(): Promise<WebSprout> {
	const dataDir = projectDataDir()
	if (dataDir) {
		const previous = globalScope.__maxstackProjectSprout
		globalScope.__maxstackProjectSprout = previous
			? previous.then((state) => groundProject(dataDir, state))
			: groundProject(dataDir)
		return globalScope.__maxstackProjectSprout
	}
	globalScope.__maxstackSprout ??= init()
	return globalScope.__maxstackSprout
}

/** The better-auth instance for this request's backend (session + `/api/auth/*`). */
export async function getAuth(): Promise<Auth> {
	const { auth } = await getSprout()
	return auth
}

const authStrict = (): boolean =>
	process.env.MAXSTACK_AUTH_STRICT === '1' ||
	process.env.MAXSTACK_AUTH_STRICT === 'true'

const apiKeyAuthScope = globalThis as typeof globalThis & {
	__maxstackApiKeysAuthReady?: boolean
}

/** The `ApiKeyService` bound to this backend — task 57's bearer-token path.
 * Independent DDL-ready flag from `api-keys.server.ts`'s (avoids a circular
 * import; both guard the same idempotent DDL, which is harmless twice). */
async function getApiKeyServiceForAuth(): Promise<ApiKeyService> {
	const { backend } = await getSprout()
	if (!apiKeyAuthScope.__maxstackApiKeysAuthReady) {
		await backend.exec(API_KEYS_DDL)
		apiKeyAuthScope.__maxstackApiKeysAuthReady = true
	}
	return new ApiKeyService({ db: backend.db })
}

/**
 * The role a stored user has right now — the key's *holder*, and
 * the identity a background run borrows (`runAs: { kind: 'user' }`).
 *
 * A key must be able to do no more than the person who issued it, and that is a
 * live question, not a snapshot: demoting someone has to demote their keys on
 * the next request, so the role is read at verify time rather than copied onto
 * the key row at issue time.
 *
 * Failure is least-privilege, not most: when the `user` table is absent (the
 * auth bundle is not installed) or the row is gone, the identity gets **no**
 * role at all. `authenticated` rules still pass — the holder is a real user —
 * and every role-gated rule refuses. The alternative, defaulting to `member`,
 * would be inventing a permission level for someone we could not look up.
 */
export async function storedRoleOf(userId: string): Promise<string | null> {
	try {
		const { backend } = await getSprout()
		const [row] = await backend.db
			.select({ role: authUserTable.role })
			.from(authUserTable)
			.where(eq(authUserTable.id, userId))
		return row?.role ?? null
	} catch {
		return null
	}
}

/**
 * Resolve the request's user. A presented `Authorization: Bearer <key>` wins
 * outright — valid resolves to an api-key identity carrying its holder's own
 * role plus the key's `apiKeyScope`, which the permission layer intersects with
 * that role (`scopeGrants`). Otherwise a real better-auth session
 * wins; without one, the dev fallback honors an `x-maxstack-role` header
 * (unit tests / quick RBAC demos) and otherwise defaults to the local admin
 * so the admin UI is usable out of the box. `MAXSTACK_AUTH_STRICT=1` disables
 * the fallback entirely — an anonymous request then resolves to `null`
 * (production posture).
 *
 * **An invalid bearer token throws 401 rather than resolving to `null`.** It
 * used to resolve to `null`, which sounds safe and reads as "no user" — but
 * `null` is the anonymous identity, and anonymous is *allowed* to read an
 * open-by-default resource. Found by driving a revoked key at the real server:
 * `GET /api/project` with a garbage token answered `200 []`. Two things were
 * wrong with that. A client cannot tell "my key was revoked" from "the
 * collection is empty", which is the worst possible time to be ambiguous; and
 * an operator revoking a key in an incident gets no signal that the caller is
 * still being served. Presenting a credential is a claim, and a claim that
 * fails verification is an error — not the absence of a claim.
 */
export async function resolveUser(
	request: Request,
): Promise<SproutUser | null> {
	const authHeader = request.headers.get('authorization')
	if (authHeader?.startsWith('Bearer ')) {
		const token = authHeader.slice('Bearer '.length).trim()
		const service = await getApiKeyServiceForAuth()
		const result = await service.verifyKey(token)
		if (!result) {
			throw Response.json(
				{ error: 'Invalid or revoked API key' },
				{ status: 401 },
			)
		}
		return {
			id: result.userId,
			// The holder's real role. Before #186 this was the literal string
			// `'api-key'`, which matched no rule anyone writes: a key could never
			// reach an admin-gated resource even in an admin's hands, and two
			// holders with very different permissions were indistinguishable. The
			// narrowing now comes from the scope, where it is enforceable.
			role: await storedRoleOf(result.userId),
			origin: 'api-key',
			apiKeyId: result.keyId,
			apiKeyScope: result.scope as ApiKeyScope,
			// Read off the key row, never off a cookie — see `resolveActiveOrg`.
			orgId: result.organizationId,
			apiKeyRateLimit: result.rateLimitPerMinute,
		}
	}
	const auth = await getAuth()
	const sessionUser = await resolveSproutUser(auth, request)
	if (sessionUser) return sessionUser as SproutUser
	if (authStrict()) return null
	// The dev fallbacks below are tagged `devFallback` so the REST write gate can
	// tell them from a real session/api-key and reject anonymous writes once the
	// auth bundle is installed (see `requireWriteAuth`). The admin UI (same-origin,
	// cookie-based) still gets the fallback for reads, so it stays browsable.
	const role = request.headers.get('x-maxstack-role')?.trim()
	if (role === 'admin' || role === 'member')
		return { id: role, role, devFallback: true }
	// Default to admin so the local admin UI is fully usable in dev.
	return { id: 'dev-admin', role: 'admin', devFallback: true }
}

/**
 * A demo spec surface with something to review — the base `newSpecSystem` only
 * carries the product (PRD) layer, so the workbench queue would be empty. We
 * apply a handful of typed spec-ops (exactly as an agent would) to land a few
 * *suggested* data/page/pricing entities plus a pending decision, mixing in one
 * `manual` field so every provenance state shows in the tree. Deterministic
 * (fixed op ids/date) so the seed is reproducible across reloads.
 */
function seedDemoSpec(): SpecSystem {
	let spec = newSpecSystem(tasklyPRD)
	let n = 0
	const meta = () => ({
		id: `op-seed-${++n}` as OpId,
		origin: 'ai' as const,
		appliedAt: '2026-07-09' as const,
		// The demo seed is a rig, not a project write — `harness` says so in the
		// trail rather than letting seeded rows read as somebody's real work.
		actor: { surface: 'harness' as const, path: 'web-demo-seed' },
	})
	spec = applyOp(
		spec,
		{
			op: 'data.addEntity',
			args: {
				entity: {
					id: 'e-project',
					name: 'Project',
					description: 'A workspace grouping related tasks',
					provenance: suggested({
						suggestedDescription: 'A workspace grouping related tasks',
					}),
					fields: [
						{
							id: 'fld-name',
							name: 'name',
							type: 'string',
							required: true,
							provenance: suggested(),
						},
						{
							id: 'fld-archived',
							name: 'archived',
							type: 'boolean',
							required: false,
							// A field the maintainer added by hand — protected from regen.
							provenance: manual(),
						},
					],
				},
			},
		},
		meta(),
	)
	spec = applyOp(
		spec,
		{
			op: 'page.addPage',
			args: {
				page: {
					id: 'pg-projects',
					name: 'Projects',
					route: '/projects',
					entityId: 'e-project',
					provenance: suggested({ priority: 'high' }),
					blocks: [{ id: 'blk-table', type: 'table', provenance: suggested() }],
				},
			},
		},
		meta(),
	)
	spec = applyOp(
		spec,
		{
			op: 'pricing.addTier',
			args: {
				tier: {
					id: 'tr-team',
					name: 'Team',
					priceMonthly: 12,
					features: ['unlimited projects', 'shared workspaces'],
					provenance: suggested(),
				},
			},
		},
		meta(),
	)
	spec = applyOp(
		spec,
		{
			op: 'prd.recordDecision',
			args: {
				entry: {
					id: 'd-projects-vs-tags',
					question: 'Group tasks by project, or by free-form tags?',
					options: [
						{
							id: 'projects',
							description: 'First-class Project entity',
							pros: ['clear ownership'],
							cons: ['heavier model'],
						},
						{
							id: 'tags',
							description: 'Free-form tags',
							pros: ['flexible'],
							cons: ['no structure'],
						},
					],
					recommendedOptionId: 'projects',
					chosenOptionId: null,
					rationale: '',
					status: 'pending',
					decidedAt: null,
					origin: 'ai',
					recordedAt: '2026-07-09',
				},
			},
		},
		meta(),
	)
	return spec
}

// ===========================================================================
// The platform host, and the attribution it deliberately does NOT carry
// ===========================================================================

/**
 * Everything about the platform tools that is a property of *this process* —
 * the spec store, the generators, the checks, the host-wired providers. A
 * module singleton so applied ops persist across requests, mirroring the Sprout
 * store. With a data dir (the default in dev — see resolveDataDir) the spec is a
 * durable JSON document on disk, seeded from the Taskly fixture on first boot;
 * point MAXSTACK_DATA_DIR at a project (e.g. a generated project) to open
 * the workbench over that project's own spec. In-memory only under unit tests.
 *
 * What it pointedly leaves out is who is writing. `PlatformContext` bundles two
 * unlike things: *capabilities*, which are per-process and expensive to build,
 * and *attribution*, which is per-request and free. Storing both in one
 * singleton meant whoever wrote the singleton picked one answer for every
 * caller forever — and picked `origin: 'ai'`, because at the time the only
 * caller was `POST /mcp`. Then the workbench's Land button started calling
 * `executePlatformTool` in process, and a maintainer clicking a button in a
 * browser began recording `{origin: 'ai', actor: {surface: 'mcp'}}` (issue
 * #358). Nothing warned, because a singleton has nothing to warn about.
 *
 * So the singleton is now the capability half only, and its type says so:
 * `PlatformHost` cannot be passed to `executePlatformTool`, because it has no
 * `origin` and no `surface`. Every write goes through {@link platformFor},
 * which demands both. That is a compile error rather than a convention — the
 * same posture as `scripts/check-write-paths.mjs` being an allowlist.
 */
export type PlatformHost = Omit<
	PlatformContext,
	'origin' | 'surface' | 'writePath' | 'actor' | 'authorship'
>

/**
 * The per-request half: what a caller must state about itself before these
 * tools will land anything for it.
 *
 * `authorship` is the one optional member, and it is optional because it is the
 * one fact a *request* cannot supply (issue #359): `platformAttributionFor` can
 * see the transport and therefore the requester, but who wrote the change is a
 * property of the change. Only a caller holding the record — Land, holding the
 * proposal it is landing — can name it, so it is stated there rather than
 * derived here.
 */
export type PlatformAttribution = Pick<
	PlatformContext,
	'origin' | 'surface' | 'writePath' | 'actor' | 'authorship'
>

const platformScope = globalThis as typeof globalThis & {
	__maxstackPlatform?: PlatformHost
}

function buildSpecStore(): SpecStore {
	const specDir = resolveSpecPath()
	if (!specDir) return createInMemorySpecStore(seedDemoSpec())
	return createFileSpecStore(specDir, { seed: seedDemoSpec })
}

export function getPlatform(): PlatformHost {
	platformScope.__maxstackPlatform ??= {
		spec: buildSpecStore(),
		generators: defaultGeneratorRunner(),
		checks: defaultCheckRunner(),
		now: () => new Date().toISOString().slice(0, 10),
		nextOpId: () => `op-${crypto.randomUUID()}` as OpId,
		// Catalog discovery + install preview over MCP. Wired here
		// rather than inside `@maxstack/mcp`, which deliberately does not depend on
		// the feature catalog — see `PlatformContext.catalog`.
		catalog: {
			list: async () => describeCatalog(await installedBundleRecords()),
			preview: async (slugs) =>
				previewInstall(
					await getPlatform().spec.load(),
					slugs,
					(await installedBundleRecords()).map((b) => b.slug),
				),
		},
		// The ownership drift report over MCP. Host-wired on
		// `catalog`'s terms — drift is a *disk* fact and `@maxstack/mcp` has only a
		// spec store. Lazy import: the loader reaches for `node:fs`, and the
		// platform context is built in modules the client bundle also pulls types
		// from.
		ownership: {
			drift: async () =>
				(await import('./workbench/drift.server')).loadOwnershipDrift(),
			// The same facts the bulk pane reads, through the same function, so
			// `review_queue` over MCP and the pane in the browser cannot disagree
			// about which of the same proposals are batchable. They did once, when
			// only the web host consulted the manifest, and a risk signal one surface
			// ignores is a risk signal nobody trusts.
			riskContext: async () =>
				(await import('./workbench/bulk-review.server')).ownershipContext(
					await getPlatform().spec.load(),
				),
		},
		// Review cost over MCP, host-wired on the same terms: it is
		// derived from an event log on disk and gated on the project's opt-in.
		// Returns `null` when the project did not opt in — the agent sees an absent
		// measurement rather than a zero it would read as "review is free".
		reviewCost: {
			report: async () =>
				(await import('./workbench/review-cost.server')).reviewCostReport(),
		},
		// The disk facts behind the ordered what-needs-you report, so
		// the `workbench` MCP tool served from this host answers with the same drift
		// and upgrade facts the pane renders. Without it the tool would still work
		// and would name those categories unevaluated — honest, but needlessly
		// thinner than the host can actually manage.
		attention: {
			inputs: async () =>
				(await import('./workbench/attention.server')).attentionInputs(
					await getPlatform().spec.load(),
				),
		},
	}
	return platformScope.__maxstackPlatform
}

/**
 * The process's platform capabilities, plus one caller's attribution — the only
 * way to get something `executePlatformTool` will accept.
 *
 * A fresh object per call over a shared host: the capabilities are the
 * expensive, stateful part and are genuinely process-wide (one spec store, one
 * generator registry), while `{origin, surface, writePath, actor}` is four
 * fields that cost nothing to rebuild and are wrong the moment they are
 * remembered across two requests.
 */
export function platformFor(attribution: PlatformAttribution): PlatformContext {
	return { ...getPlatform(), ...attribution }
}

/**
 * The JSON-RPC endpoint (`app/routes/mcp.ts`). Kept as a named constant beside
 * the rule that reads it so the coupling is visible from both ends.
 */
const MCP_ENDPOINT = '/mcp'

/**
 * What the platform tools may claim about a request that arrived over HTTP.
 *
 * One derivation for every entry point into this app, rather than a default
 * somebody remembers to override — which is precisely how issue #358 happened,
 * except that the singleton was not even a default, it was an answer given once
 * at boot and then applied to everybody.
 *
 * The rule is that the **transport is the signal**, the same reasoning the stdio
 * host settles `origin` with (issue #279) and the only signal that is actually
 * available here:
 *
 *   - `POST /mcp` is the agent protocol. Nothing else speaks JSON-RPC to this
 *     app; a person uses the workbench. So `{ai, mcp}`.
 *   - Everything else arrived from a browser — a workbench action, an admin or
 *     project form post, a REST call. So `{human, web}`.
 *
 * Two things it deliberately does not do. It does not read `MAXSTACK_AGENT` /
 * `MAXSTACK_SESSION` the way the CLI and the stdio host do: that environment
 * belongs to the *server process*, not to whoever made the request, and copying
 * the CLI's resolution here would stamp the operator's agent name on every
 * visitor's write. And it does not try to distinguish an api-key REST caller
 * from an interactive one, because it does not have to — `mayUsePlatformTools`
 * in `@maxstack/mcp` refuses an api-key identity the platform tools outright,
 * and no REST route touches the spec at all. The `web`/`human` answer applies
 * only where it can actually be recorded, and there it is right.
 *
 * The runtime `origin: 'system'` of a background write is a different axis
 * entirely and is untouched by any of this: it lives on the audit log
 * (`session | api-key | mcp | system | portal`, see `sources.server.ts`), and
 * the source-loop guard reads it there. A `PlatformContext` cannot express
 * `system` and never could — background work does not author spec ops.
 */
export function platformAttributionFor(request: Request): PlatformAttribution {
	const isJsonRpc = new URL(request.url).pathname === MCP_ENDPOINT
	return isJsonRpc
		? { origin: 'ai', surface: 'mcp' }
		: { origin: 'human', surface: 'web' }
}

// The audit sink is a process-lifetime singleton so a record's history survives
// spec re-grounding and dev HMR (which rebuild the store). In-memory is enough
// for the demo/admin; a real deployment swaps in `createDrizzleAuditSink` over
// the `audit_log` table (the `audit` bundle) without touching the ops or routes.
const auditScope = globalThis as typeof globalThis & {
	__maxstackAudit?: AuditSink & { query: AuditReader }
	__maxstackWebhooks?: Promise<WebhookService>
	__maxstackJobs?: Promise<JobQueue>
}

// The live DDL is the feature's own `JOBS_DDL` — deliberately not a local copy.
// It is idempotent (`CREATE TABLE IF NOT EXISTS` **plus** `ADD COLUMN IF NOT
// EXISTS` for the issue-#181 columns), so a project whose `job` table predates
// them is upgraded rather than silently left with a table missing the columns
// every read now expects. A hand-maintained second copy here is exactly how
// that divergence happened before.
const JOBS_LIVE_DDL = JOBS_DDL

/**
 * Task 59's queue: a process-lifetime singleton (same HMR-survival reasoning
 * as `getAuditSink`'s memory sink) over the persisted `job` table, with the
 * poll worker (`start()`) running once per process. Two job types are wired
 * here — `webhook.emit` (moves task 58's delivery off the mutation's request
 * path) and `export.csv` (a server-side bulk export) — both registered
 * lazily on first construction so a fresh HMR reload re-registers handlers
 * without losing already-persisted rows.
 */
export function getJobQueue(): Promise<JobQueue> {
	auditScope.__maxstackJobs ??= (async () => {
		const { backend, registry, store } = await getSprout()
		await backend.exec(JOBS_LIVE_DDL)
		const queue = new JobQueue({ store: createDrizzleJobStore(backend.db) })

		queue.register<WebhookEvent>('webhook.emit', async (event) => {
			const webhooks = await webhookServiceForAudit()
			await webhooks.emit(event)
		})

		queue.register<{ resource: string; limit?: number }>(
			'export.csv',
			async (input) => {
				const { resourceToCsv } = await import('@maxstack/ui')
				const entry = registry.get(input.resource)
				if (!entry) throw new Error(`Unknown resource "${input.resource}"`)
				const rows = await store.list(input.resource, {
					limit: input.limit ?? 10_000,
				})
				return {
					resource: input.resource,
					rowCount: rows.length,
					csv: resourceToCsv(entry.resource, rows),
				}
			},
		)

		// Retention purge: hard-deletes rows a `softDelete: true`
		// resource soft-deleted more than 30 days ago (`comment` in the demo
		// registry, see `buildRegistry` above) — the other half of "recoverable
		// within a window". Runs on the same queue/process-lifetime schedule as
		// the other background jobs.
		schedulePurgeJob(queue, {
			registry,
			store,
			intervalMs: 24 * 60 * 60 * 1000,
		})

		// Notification digests. The sweep asks who has an address and
		// fans out one job per recipient; both handlers are idempotent, which is
		// what makes them safe on a queue that retries.
		//
		// Daily, regardless of anyone's cadence: the *window key* is what a
		// recipient's `digest-cadence` preference decides, so a weekly reader's
		// six extra sweeps all claim the same window and mail nothing. Scheduling
		// per cadence would mean two schedules to keep in step with one preference.
		//
		// The service is resolved lazily — `notifications.server.ts` imports this
		// module, so reaching for it eagerly here would be a cycle.
		registerDigestJobs(queue, {
			service: async () =>
				(await import('./notifications.server')).getNotificationService(),
			recipients: async () => {
				const rows = (await backend.db.select().from(authUserTable)) as {
					id: string
					email?: string
				}[]
				return rows
					.map((row) => ({ userId: row.id, email: row.email ?? '' }))
					.filter((recipient) => recipient.email !== '')
			},
		})
		scheduleInterval(queue, {
			type: DIGEST_SWEEP_JOB_TYPE,
			intervalMs: 24 * 60 * 60 * 1000,
		})

		// Declared recurrence. The registry is the project's generated
		// `jobs/schedules.generated.ts`, surfaced through the owned-code manifest
		// — so a handler somebody filled in actually runs. It is empty
		// for a plain `apps/web` build and for a project that declared no schedule,
		// and an unfilled slot still dead-letters naming the file to create, which
		// is the message somebody who just ran `schedules.declare` needs. That file
		// is now one `maxstack gen` away rather than one nobody writes.
		//
		// `onOccurrence` is the platform's own half of an occurrence: the declared
		// source syncs a schedule triggers. A schedule declared purely
		// to drive a sync therefore runs without demanding a handler file nobody has
		// content for, while a schedule nothing claimed still dead-letters.
		registerScheduleHandlers(queue, OWNED_SCHEDULE_HANDLERS, {
			onOccurrence: async (occurrence) =>
				(await import('./sources.server')).enqueueScheduledSyncs(occurrence),
		})

		// Declared external sources (made reachable by #236). The
		// refiner registry is the project's generated `sources/sources.generated.ts`
		//; every other option is a seam this process fills so the
		// feature never writes a row, never reads a row, and never holds an
		// identity of its own — see `sources.server.ts`.
		//
		// Lazily imported for `notifications.server`'s reason: that module imports
		// this one, so reaching for it eagerly here would be a cycle.
		registerSourceHandlers({
			queue,
			refiners: OWNED_SOURCE_REFINERS,
			sources: async () => (await import('./sources.server')).declaredSources(),
			entity: async (entityId) =>
				(await import('./sources.server')).sourceEntity(entityId),
			apply: async (writes, source, runAs, entity) =>
				(await import('./sources.server')).applySourceWrites(
					writes,
					source,
					runAs,
					entity,
				),
			readRow: async (source, rowId, runAs) =>
				(await import('./sources.server')).readSourceRow(source, rowId, runAs),
		})

		const scheduler = new Scheduler({
			queue,
			// Read through on every tick rather than snapshotting: a schedule paused
			// ten seconds ago has to stop firing without a restart.
			schedules: async () => schedulesOf(await getPlatform().spec.load()),
		})
		scheduler.start()

		queue.start()
		return queue
	})()
	return auditScope.__maxstackJobs
}

/** Idempotent DDL for the webhook tables (mirrors `webhooks.server.ts`'s local
 * copy — `IF NOT EXISTS`-guarded, independent DDL-ready flag, no circular import). */
const WEBHOOKS_LIVE_DDL = `
CREATE TABLE IF NOT EXISTS webhook_subscription (
  id text PRIMARY KEY,
  user_id text NOT NULL,
  url text NOT NULL,
  secret text NOT NULL,
  events jsonb NOT NULL,
  active boolean NOT NULL DEFAULT true,
  created_at timestamp NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS webhook_delivery (
  id text PRIMARY KEY,
  subscription_id text NOT NULL,
  event_type text NOT NULL,
  payload jsonb NOT NULL,
  status text NOT NULL,
  attempts integer NOT NULL,
  response_status integer,
  error text,
  created_at timestamp NOT NULL DEFAULT now()
);
`

function webhookServiceForAudit(): Promise<WebhookService> {
	auditScope.__maxstackWebhooks ??= (async () => {
		const { backend } = await getSprout()
		await backend.exec(WEBHOOKS_LIVE_DDL)
		return new WebhookService({ db: backend.db })
	})()
	return auditScope.__maxstackWebhooks
}

/**
 * Task 58's event bus: every audit entry — from the generic `/api/:resource`
 * + admin-UI mutation path (`operations.ts`'s `record()`) and from
 * `MemberService`'s injected sink alike, since both share this singleton —
 * also fans out to `WebhookService.emit` as `${resource}.${action}`. The base
 * sink's behavior (history read via `.query`) is unchanged; webhook emission
 * is additive and its failures are swallowed here on top of `emit`'s own
 * internal catch — a subscriber must never be able to break app mutations.
 *
 * Task 59 moves the actual delivery off this request path: rather than
 * `await`ing `WebhookService.emit` inline, the audit sink only *enqueues* a
 * `webhook.emit` job — the mutation's response returns immediately, and the
 * queue's poll worker (`getJobQueue`) delivers (and retries) it out of band.
 * Delivery status is then visible on the `/jobs` page instead of only in a
 * swallowed catch.
 */
export function getAuditSink(): AuditSink & { query: AuditReader } {
	auditScope.__maxstackAudit ??= createMemoryAuditSink()
	const base = auditScope.__maxstackAudit
	const wrapped = async (entry: Parameters<AuditSink>[0]) => {
		await base(entry)
		try {
			const jobs = await getJobQueue()
			await jobs.enqueue({
				type: 'webhook.emit',
				payload: {
					type: `${entry.resource}.${entry.action}`,
					resource: entry.resource,
					resourceId: entry.resourceId,
					data: entry.metadata,
				} satisfies WebhookEvent,
			})
		} catch {
			// Enqueueing is observational from the mutation's point of view — a
			// bus/dispatch failure must never surface to the caller.
		}
		try {
			// The enrichment trigger. A declared `enrich` source with a
			// `create`/`update` trigger enqueues a run for the row that just landed —
			// here rather than inside the op, on `publish`'s reasoning and one more:
			// an inline enrichment makes a third party's outage into a failed create,
			// which is the exact failure the feature queues in order to avoid. It
			// borrows the writer's own identity, so a source can never reach a row
			// the person who triggered it could not.
			//
			// **A source's own write never triggers one**, and that is the loop
			// guard: the enrichment's own `opUpdate` is a write on the same row of
			// the same entity, so without this a source with an `update` trigger
			// would enrich its own output forever.
			//
			// It reads `sourceKey` — stamped by the ops off the borrowed identity —
			// rather than `origin !== 'system'`. The origin form was a
			// real bound only for as long as a source run was the one thing in the
			// process writing as `system`: a future background writer adopting that
			// origin for its own perfectly good reasons would silently stop
			// triggering enrichments, and the symptom would be "our enrichment
			// stopped running" with nothing pointing at the cause. This asks the
			// question the guard actually means.
			if (writeTriggersEnrichment(entry)) {
				const { enqueueWriteEnrichments } = await import('./sources.server')
				await enqueueWriteEnrichments({
					resource: entry.resource,
					action: entry.action,
					rowId: entry.resourceId,
					userId: entry.userId,
					// The tenant the triggering write happened in. An
					// enrichment of somebody's own row has to be able to reach that row,
					// and a background run has no request to resolve an active org from —
					// so it inherits the one the write that triggered it resolved.
					orgId: entry.orgId,
					// The *write* is the occurrence: the sink fires exactly once per
					// committed op, so two edits a minute apart enrich twice (the second
					// may have fixed the ISBN) and nothing here is replayed.
					occurrence: crypto.randomUUID(),
				})
			}
		} catch {
			// Same posture as the bus above: a committed write is committed, and a
			// queue that would not take the job is not the writer's problem.
		}
	}
	return Object.assign(wrapped, { query: base.query })
}

/** Name of the cookie the org switcher sets. Value = the active org's id. */
export const ORG_COOKIE = 'maxstack-org'

function orgCookieOf(request: Request): string | undefined {
	const cookie = request.headers.get('cookie') ?? ''
	const match = cookie.match(/(?:^|;\s*)maxstack-org=([^;]+)/)
	return match?.[1] ? decodeURIComponent(match[1]) : undefined
}

/**
 * Resolve the request's active org (task 51, d-tenancy-model). The org-switcher
 * cookie is a *claim*; when the project has a `member` resource (the members
 * bundle), the claim is verified against membership and a non-member's claim
 * resolves to no org — which the ops layer then denies for tenant-scoped
 * resources. Without a member resource there is nothing to verify against, so
 * the claim is honored (dev parity with the `x-maxstack-role` fallback).
 */
async function resolveActiveOrg(
	request: Request,
	user: SproutUser,
	registry: ResourceRegistry,
	store: SproutStore,
): Promise<string | undefined> {
	// An api-key identity's org is whatever the key was issued for, full stop
	//. The cookie is a claim the *browser* makes and the membership
	// check below is what makes honoring it safe — but that check only runs when
	// the project has a `member` resource, so without the members bundle a
	// scripted caller could previously set `maxstack-org` to any value and have
	// it honored. A key carries no session to check against, so it does not get
	// to claim at all: null org means it reaches no tenant-scoped resource.
	if (user.apiKeyId) return user.orgId ?? undefined
	const claimed = orgCookieOf(request)
	if (!claimed) return undefined
	return verifiedOrg(user.id, claimed, registry, store)
}

/**
 * The org `userId` may act in, given a claim — the membership half of {@link
 * resolveActiveOrg}, split out because background work makes the same claim
 * from somewhere other than a cookie.
 *
 * When the project has a `member` resource (the members bundle) the claim is
 * verified and a non-member's claim resolves to no org. Without a member
 * resource there is nothing to verify against, so the claim is honored — dev
 * parity with the `x-maxstack-role` fallback, and the same bargain the cookie
 * path has always struck.
 */
async function verifiedOrg(
	userId: string,
	claimed: string,
	registry: ResourceRegistry,
	store: SproutStore,
): Promise<string | undefined> {
	if (!registry.has('member')) return claimed
	const memberships = await store.list('member', {
		filter: { userId, organizationId: claimed },
		limit: 1,
	})
	return memberships.length > 0 ? claimed : undefined
}

/**
 * The org a *borrowed* identity may act in.
 *
 * A source run has no request, so it has no org-switcher cookie to resolve an
 * active org from — it carries a claim the enqueued `runAs` made instead, and
 * this is where that claim is checked. It re-reads membership **now** rather
 * than trusting the job row, on `storedRoleOf`'s argument: removing somebody
 * from an org has to stop the runs their membership authorized, and an org
 * frozen onto a queued job is a permission decision made at the wrong moment.
 */
export async function activeOrgFor(
	userId: string,
	claimed: string | undefined,
): Promise<string | undefined> {
	if (!claimed) return undefined
	const { registry, store } = await getSprout()
	return verifiedOrg(userId, claimed, registry, store)
}

/**
 * The orgs an `eachOrg` run fans out over — the IO half of
 * `fanOutRunAs`, which is pure and decides what the runs then are.
 *
 * The two identities enumerate different things, for the reason they resolve a
 * single `orgId` differently. A **service** role has no membership to narrow it,
 * so its fan-out is every org in the project and the declaration is the review. A
 * **user**'s is the orgs they are a member of, read now rather than declared: the
 * fan-out has to narrow the moment somebody leaves an org, which is
 * `activeOrgFor`'s argument applied to a set instead of a claim.
 *
 * A project with no `organization` resource returns none rather than inventing
 * one, and `truncated` says the ceiling was hit — a fan-out that silently covers
 * the first 200 of 5000 tenants reads as working, which is the failure this bound
 * exists to make visible rather than to cause.
 *
 * Ordered by id, so the same tenant list produces the same runs on every fire
 * instead of a rotating subset when the bound truncates.
 */
export async function orgsForRunAs(
	runAs: ScheduleRunAs,
): Promise<{ orgIds: string[]; truncated: boolean }> {
	const { registry, store } = await getSprout()
	return orgsForIdentity(registry, store, runAs)
}

/**
 * The enumeration itself, over a registry and store somebody else built.
 *
 * Split from {@link orgsForRunAs} for {@link applyWritesWith}'s reason: the rule
 * that decides which tenants a run covers — every org, or only the ones a
 * membership row still says the user belongs to — is the part worth driving
 * against a real registry and a real database, and the process-lifetime singleton
 * is the part that makes that impossible.
 */
export async function orgsForIdentity(
	registry: ResourceRegistry,
	store: SproutStore,
	runAs: ScheduleRunAs,
): Promise<{ orgIds: string[]; truncated: boolean }> {
	// One past the bound: enough to know the fan-out was truncated without reading
	// a tenant table that may be very much larger than the bound.
	const ceiling = MAX_FANOUT_ORGS + 1
	const ids: string[] = []
	if (runAs.kind === 'service') {
		if (!registry.has('organization')) return { orgIds: [], truncated: false }
		const primaryKey = registry.get('organization')?.resource.primaryKey ?? 'id'
		const rows = await store.list('organization', {
			limit: ceiling,
			orderBy: primaryKey,
		})
		for (const row of rows) {
			const id = row[primaryKey]
			if (typeof id === 'string' && id !== '') ids.push(id)
		}
	} else {
		if (!registry.has('member')) return { orgIds: [], truncated: false }
		const rows = await store.list('member', {
			filter: { userId: runAs.userId },
			limit: ceiling,
			orderBy: 'organizationId',
		})
		for (const row of rows) {
			const id = row.organizationId
			// Two memberships in one org would otherwise be two runs in it.
			if (typeof id === 'string' && id !== '' && !ids.includes(id)) ids.push(id)
		}
	}
	return {
		orgIds: ids.slice(0, MAX_FANOUT_ORGS),
		truncated: ids.length > MAX_FANOUT_ORGS,
	}
}

export async function getContext(request: Request): Promise<McpContext> {
	const { registry, store } = await getSprout()
	const user = await resolveUser(request)
	if (user) {
		user.orgId = await resolveActiveOrg(request, user, registry, store)
	}
	// Attribution is derived from the request, not remembered from boot — see
	// `platformAttributionFor` and issue #358. This is the whole reason it is a
	// parameter: `getContext` is the one place in the web app that has the
	// request in hand, and every HTTP entry point comes through it.
	return contextForUser(user, platformAttributionFor(request))
}

/**
 * The same op context, for an identity that did not arrive on a request.
 *
 * Background work has no `Request` to resolve a user
 * from, but it must not therefore have a *different* context: every hook below
 * — the audit sink, derived values, the live fan-out — is what makes a write
 * from the queue indistinguishable from a write from a form, which is the whole
 * claim `SourceWriteApplier` makes. `getContext` is this function plus the two
 * steps that need the request (resolving the identity, resolving its active
 * org), so the two cannot drift.
 */
export async function contextForUser(
	user: SproutUser | null,
	platform?: PlatformAttribution,
): Promise<McpContext> {
	const { registry, store } = await getSprout()
	return {
		registry,
		store,
		user,
		// Omitted, not defaulted, when the caller named no attribution. `platform`
		// is optional on `McpContext` precisely so a context that cannot honestly
		// say who is writing does not get spec-authoring tools — which is the right
		// answer for background work: a source poll or a queued job is not an
		// author, and `PlatformContext` has no vocabulary for one (`origin` is
		// `ai | human`, and the runtime's `system` lives on the audit log, where
		// the source loop guard still reads it). A future HTTP entry point that
		// forgets to attribute itself therefore fails loudly with "unknown tool"
		// rather than quietly landing ops under somebody else's name.
		...(platform ? { platform: platformFor(platform) } : {}),
		// Records create/update/delete so per-record history has something to read.
		audit: getAuditSink(),
		// Populates computed fields and rollups on every read op, so
		// REST, MCP and the admin UI all see them without each remembering to ask.
		derived: resolveRowDerived,
		// Fans a committed change out to any declared live channel over the
		// resource. Wired here rather than inside the ops for
		// `audit`'s and `derived`'s reason — the channel table lives in this
		// process and core cannot reach it — and best-effort for `audit`'s reason
		// too: a broken socket must never fail a committed write.
		//
		// Imported lazily so the channel module and its `LiveChannel` map are not
		// pulled into every module that touches a context. `publishLiveChange` is
		// a no-op when no channel is open, which is the common case.
		live: async (resource, id) => {
			const { publishLiveChange } = await import('./live.server')
			await publishLiveChange(resource, id)
		},
	}
}

/** `GET`→`read`, `POST`→`create`, `PUT`/`PATCH`→`update`, `DELETE`→`delete` —
 * the REST verb→`SproutAction` mapping the api-key scope gate checks against. */
export function restAction(
	method: string,
): 'read' | 'create' | 'update' | 'delete' | null {
	switch (method) {
		case 'GET':
			return 'read'
		case 'POST':
			return 'create'
		case 'PUT':
		case 'PATCH':
			return 'update'
		case 'DELETE':
			return 'delete'
		default:
			return null
	}
}

/**
 * Task 57: an api-key-authenticated request (`ctx.user.apiKeyScope` set) may
 * only perform actions its scope grants for `resource` — narrower than, never
 * wider than, the resource's own `ResourceAccess` rule. Session requests
 * (`apiKeyScope` undefined) are unaffected. Returns a 403 `Response` to
 * short-circuit with, or `null` when the call may proceed.
 *
 * **This is no longer the gate; it is the error message.** Since #186 the scope
 * is enforced inside `authorize()`/`canPerformAction()` in the permission
 * layer, which every read and mutation funnels through — including the MCP
 * endpoint and the admin loaders, neither of which passes through here at all.
 * What this keeps buying is a specific `403 Out of scope` on the REST surface,
 * returned before any work is done, instead of the generic permission denial an
 * out-of-scope call would otherwise surface as. It delegates to `scopeGrants`
 * rather than restating the rule, so the two can never disagree.
 */
export function checkApiKeyScope(
	ctx: McpContext,
	resource: string,
	method: string,
): Response | null {
	if (!ctx.user?.apiKeyScope) return null
	const action = restAction(method)
	if (action && scopeGrants(ctx.user, resource, action)) return null
	return Response.json({ error: 'Out of scope' }, { status: 403 })
}

/**
 * Reject an anonymous **write** to the REST API once the auth bundle is
 * installed. Without this the dev fallback (`resolveUser` → `dev-admin`) makes
 * every external `POST`/`PUT`/`PATCH`/`DELETE` run as admin, so installing auth
 * did not actually protect writes on the API surface (retested: POST 201 /
 * DELETE 200). Reads are untouched (the admin UI stays browsable), and a real
 * session or api-key passes straight through — `authorize()` still runs
 * downstream, so this only closes the anonymous hole, it doesn't replace RBAC.
 *
 * Returns a 401 `Response` to short-circuit with, or `null` to proceed.
 */
export async function requireWriteAuth(
	ctx: McpContext,
	method: string,
): Promise<Response | null> {
	const { authInstalled } = await getSprout()
	if (!isAnonymousWrite(method, authInstalled, ctx.user)) return null
	return Response.json({ error: 'Authentication required' }, { status: 401 })
}

/**
 * The pure decision behind {@link requireWriteAuth}: is this a *write* that
 * should be rejected as anonymous? True only when the method mutates, the auth
 * bundle is installed, and the caller is not a real principal (no user, or a
 * `devFallback`-tagged dev identity). A real session or api-key user passes.
 */
export function isAnonymousWrite(
	method: string,
	authInstalled: boolean,
	user: SproutUser | null,
): boolean {
	const action = restAction(method)
	if (action === null || action === 'read') return false
	if (!authInstalled) return false
	return !user || user.devFallback === true
}

/**
 * The current session's per-action capabilities for a resource — the UI's read
 * of what it may offer, computed with the same rules the server enforces (task
 * 22 / 35). List-level (row-less), so an `owner` rule reads as denied here and
 * the affordance is re-checked per row on the server.
 */
export async function resolveCapabilities(
	ctx: McpContext,
	resource: string,
): Promise<ResourceCapabilities> {
	const entry = ctx.registry.get(resource)
	if (!entry) {
		return { read: false, create: false, update: false, delete: false }
	}
	return resourceCapabilities(
		resource,
		entry.config.access,
		createAccessContext(ctx.user),
	)
}

/**
 * The declared list actions for a resource, in the shape a control renders from.
 *
 * A projection of the registry plan rather than a re-derivation of it: the key,
 * the label, the arity, the cap and the option list are handed through
 * unchanged, and everything the server alone needs — the write set, the role —
 * stays behind. That split is the point. The browser is told what to *offer*,
 * never what an action writes, so there is nothing in the payload a tampered
 * client could turn into a different write. `opRunAction` reads the plan itself.
 *
 * The cap travels, though, and it is the one number that looks like enforcement
 * and is not: the bar disables itself past it as a courtesy, because the server
 * refuses an oversized run *whole* rather than truncating, and finding that out
 * after ticking four hundred rows is worse than being told first.
 */
export function listActionDescriptors(
	ctx: McpContext,
	resource: string,
): ListActionDescriptor[] {
	const entry = ctx.registry.get(resource)
	return (entry?.config.actions ?? []).map((plan) => ({
		key: plan.key,
		label: plan.label,
		description: plan.description,
		arity: plan.arity,
		...(plan.choose
			? { choose: { column: plan.choose.column, options: plan.choose.options } }
			: {}),
		maxSelection: plan.maxSelection,
		undoable: plan.undoable,
	}))
}

/**
 * Batch-resolve every `file` column in `rows` into viewer-bound signed URLs
 * — the file twin of {@link resolveRowReferences}.
 *
 * A file column stores a storage key, not a URL, because a signed URL written
 * into a row is a value that expires while the row keeps claiming it works. The
 * cost of that choice is that a read surface cannot render a key on its own:
 * signing needs the secret, so it happens here, once per page, for the viewer
 * making the request.
 *
 * Minting a URL is the authorization decision. It happens only for rows that
 * came back from the access-controlled read path — a caller who cannot see the
 * row never reaches this function, and the gateway then refuses any token not
 * bound to them.
 *
 * Declared derivatives are signed alongside the original, so a list can render
 * a thumbnail without a second round trip.
 */
export function resolveRowFiles(
	introspection: SproutResource,
	rows: readonly Row[],
	viewer: string | null,
): FileResolution {
	const fileColumns = introspection.columns.filter(
		(c) => c.meta.isFile === true,
	)
	if (fileColumns.length === 0) return {}

	const resolution: FileResolution = {}
	for (const row of rows) {
		for (const column of fileColumns) {
			const key = row[column.name]
			// Only a stored key gets signed. A legacy URL value (written before keys
			// were stored) is left for the field to render as-is rather than being
			// re-signed as though it were a key.
			if (typeof key !== 'string' || !key || isUrlValue(key)) continue
			if (resolution[key]) continue

			const derivatives: Record<string, string> = {}
			for (const derivative of column.meta.fileDerivatives ?? []) {
				derivatives[derivative.name] = signedFileUrl(
					derivativeKey(key, derivative.name),
					viewer,
				)
			}
			resolution[key] = {
				url: signedFileUrl(key, viewer),
				...(Object.keys(derivatives).length > 0 ? { derivatives } : {}),
			}
		}
	}
	return resolution
}

/**
 * Batch-resolve every FK in `rows` to a display string, so `<ResourceList>` /
 * `<Show>` render the referenced record's title instead of a raw id (Plan v5
 * task 32). One `getMany` per referenced table; the display column falls back to
 * that table's registered `titleField` when the FK didn't carry one. Returns a
 * serializable map the loader hands to the `references` prop.
 */
export async function resolveRowReferences(
	ctx: McpContext,
	introspection: SproutResource,
	rows: readonly Row[],
): Promise<ReferenceMap> {
	return resolveReferences(introspection, rows, {
		getMany: async (table, ids) => {
			try {
				return await opGetMany(ctx, table, ids)
			} catch {
				// An unreadable referenced table — e.g. `user` (read: authenticated)
				// under an anonymous session — resolves to nothing, so the cell falls
				// back to the raw id instead of failing the whole page. Mirrors
				// `referenceFieldOptions`' posture.
				return []
			}
		},
		displayFieldFor: (table) => ctx.registry.get(table)?.config.titleField,
	})
}

/**
 * Index the grounded shapes by resource name so the read path can find a
 * resource's derived values. Only resources that actually have some
 * are recorded, so the map is empty for a spec with no rollups and the read path
 * short-circuits.
 */
export function derivedByResource(
	shapes: readonly SpecEntityShape[],
): Map<string, { computed: ComputedShape[]; rollups: RollupShape[] }> {
	const out = new Map<
		string,
		{ computed: ComputedShape[]; rollups: RollupShape[] }
	>()
	for (const shape of shapes) {
		const computed = shape.computed ?? []
		const rollups = shape.rollups ?? []
		if (computed.length > 0 || rollups.length > 0) {
			out.set(shape.name, { computed, rollups })
		}
	}
	return out
}

/**
 * Attach a resource's derived values to a page of rows — computed
 * fields evaluated in JS, rollups aggregated in SQL and batched across the page.
 *
 * This is the `derived` resolver on the op context, so every read op carries it
 * and no individual route has to remember: a list, a REST `GET /api/:resource`
 * and an MCP `list_records` all return the same shape.
 *
 * Ordering matters: computed fields land **first**, so a row already carries them
 * before anything reads it. Rollups are independent of the owner row's computed
 * values (they aggregate the *child* table, where the expression is inlined into
 * the SQL instead), so the two passes never need to interleave.
 *
 * A rollup that throws degrades to its empty value rather than failing the page;
 * the error is logged once with the rollup's name so a broken aggregate is
 * diagnosable instead of silently blank — the "never silently render an empty
 * surface" half of #170's honest-failure gate, at runtime rather than at validate.
 */
export async function resolveRowDerived(
	resource: string,
	rows: readonly Row[],
): Promise<Row[]> {
	if (rows.length === 0) return [...rows]
	const sprout = await getSprout()
	const derived = sprout.derived?.get(resource)
	if (!derived) return [...rows]
	const withComputed = applyComputed(rows, derived.computed)
	if (derived.rollups.length === 0) return withComputed
	return resolveRollups(withComputed, derived.rollups, {
		run: async ({ text, params }) =>
			(await sprout.backend.query(text, params)) as RollupResultRow[],
		idColumn: sprout.registry.get(resource)?.resource.primaryKey ?? 'id',
		onError: (rollup, err) => {
			console.error(
				`[maxstack] rollup "${rollup.name}" on ${resource} failed; the card will read empty: ${
					err instanceof Error ? err.message : String(err)
				}`,
			)
		},
	})
}

/** A `{ label, value }` picker choice — the referenced record's title + id. */
export interface ReferenceChoice {
	label: string
	value: string
}

/**
 * For every FK column of `introspection`, list the referenced table into
 * `{ label: <title>, value: <id> }` choices — the option set the form's FK
 * autocomplete (`<AutocompleteInput>`) picks from (Plan v5 task 32). Keyed by
 * the FK column name so a route can drop them straight into `uiOptions`.
 */
export async function referenceFieldOptions(
	ctx: McpContext,
	introspection: SproutResource,
): Promise<Record<string, ReferenceChoice[]>> {
	const out: Record<string, ReferenceChoice[]> = {}
	for (const col of introspection.columns) {
		// Single FK or the "many" side (an array reference, task 38) — both pick
		// from the same option set (the referenced table's records).
		const ref = col.references ?? col.meta?.arrayReference
		if (!ref) continue
		const display =
			ref.displayField ?? ctx.registry.get(ref.table)?.config.titleField
		try {
			const rows = await opList(ctx, ref.table, { limit: 100 })
			out[col.name] = rows.map((r) => ({
				value: String(r[ref.column]),
				label:
					display && r[display] != null
						? String(r[display])
						: String(r[ref.column]),
			}))
		} catch {
			// An unreadable/unknown referenced table just yields no options rather
			// than failing the whole page.
			out[col.name] = []
		}
	}
	return out
}

/**
 * One resolved inverse relation of the record being shown: the child resource,
 * the noun to label it, how many rows point back, and the first page of them
 *.
 *
 * Serializable end to end — it crosses a loader boundary straight into
 * `<RelatedRecords>`, which is why the child's introspection travels with the
 * rows rather than being looked up again on the client.
 */
export interface RelatedRecordGroup {
	resource: string
	label: string
	fk: string
	count: number
	rows: Row[]
	introspection: SproutResource
	references: ReferenceMap
}

/** How many child rows a related section reads. A panel is a glance at the
 * children, not the child page — the count beside the heading is the honest
 * total, and the section links to the filtered list for the rest. */
export const RELATED_ROW_LIMIT = 5

/**
 * How many related sections resolve at once.
 *
 * A detail page's panel is N relations and therefore 2N reads (a page of rows
 * and a count each), and N is the schema's, not the request's. Running them one
 * after another makes the page's latency the *sum* of the relations an app
 * happens to declare; running them all at once makes a hub record open with
 * however many concurrent statements the schema implies. So the fan-out is
 * bounded here, in flight, rather than by dropping sections — a section that
 * silently does not render is the exact failure this panel exists to fix.
 */
export const RELATED_CONCURRENCY = 6

/**
 * Which inverse relations a detail page actually renders as sections.
 *
 * Two of the declared edges are excluded, and neither is a matter of taste:
 *
 * - an FK onto a column that is **not the target's primary key**. The read
 *   below filters `child.fk = <this row's id>`, which is the relation the FK
 *   declares only when the FK points at the id. Against any other unique column
 *   that filter is quietly wrong — the *wrong rows*, not an error — so it is
 *   skipped rather than guessed at.
 * - the child's **tenant column**. `config.tenantField` is an FK onto the org,
 *   so read as an inverse it says "every row of this entity, in this org" — on
 *   an org's own record page that is one section per entity in the app, each
 *   listing the whole table five rows at a time. A tenant column is the scope a
 *   read already runs under (`opList` forces it), not a relation between two
 *   records, and rendering it as one is both meaningless and the only way the
 *   section count scales with the size of the app rather than with the record.
 */
function relatedRelations(
	ctx: McpContext,
	resource: string,
): InverseReference[] {
	const shapes = ctx.registry.all().map((entry) => entry.resource)
	const target = ctx.registry.get(resource)
	return inverseReferences(shapes, resource).filter((inverse) => {
		const entry = ctx.registry.get(inverse.resource)
		if (!entry) return false
		if (target && inverse.targetColumn !== target.resource.primaryKey)
			return false
		return entry.config.tenantField !== inverse.column
	})
}

/**
 * For a record of `resource`, resolve every relation pointing *at* it — the
 * rows of each child entity that reference this record, plus their total
 *.
 *
 * The reverse of the FK graph `resolveReferences` walks forward, and derived
 * from the same grounded columns: `inverseReferences` reads the registry, so a
 * relation declared by `data.setFieldReference` shows up here with no per-app
 * wiring, and a relation retired disappears from the panel with the
 * declaration. This supersedes the counts-only reverse scan (Plan v5 task 38) —
 * the counts are still here, as `count`, but a count of children that could not
 * be listed is exactly the surface people then hand-wrote a loader to replace.
 *
 * Each section is a bulk read of *another* entity, so it is gated as one:
 * `opList`/`opCount` apply the **child's** own read rule and the child's own
 * tenant scope, never the host record's — the host being readable says nothing
 * about its children. A child the session may not read is omitted rather than
 * 500-ing the page, the same posture as `referenceFieldOptions` and
 * `resolveRowReferences`.
 *
 * What is bounded: `limit` rows per section (the count beside the heading
 * carries the true total), {@link RELATED_CONCURRENCY} sections resolving at
 * once, and the sections themselves narrowed by {@link relatedRelations}.
 */
export async function relatedRecords(
	ctx: McpContext,
	resource: string,
	id: string,
	options: { limit?: number } = {},
): Promise<RelatedRecordGroup[]> {
	const limit = options.limit ?? RELATED_ROW_LIMIT
	const relations = relatedRelations(ctx, resource)
	const out: RelatedRecordGroup[] = []
	for (let i = 0; i < relations.length; i += RELATED_CONCURRENCY) {
		const batch = await Promise.all(
			relations
				.slice(i, i + RELATED_CONCURRENCY)
				.map((inverse) => relatedGroup(ctx, inverse, id, limit)),
		)
		for (const group of batch) if (group) out.push(group)
	}
	return out
}

/** One resolved section, or `null` when the session may not read the child. */
async function relatedGroup(
	ctx: McpContext,
	inverse: InverseReference,
	id: string,
	limit: number,
): Promise<RelatedRecordGroup | null> {
	const entry = ctx.registry.get(inverse.resource)
	if (!entry) return null
	const filter = { [inverse.column]: id }
	let count: number
	let rows: Row[]
	try {
		// Ordered, because a `LIMIT` with no `ORDER BY` makes "the first five of
		// fifty" a different five per render — see `relatedOrder`.
		;[count, rows] = await Promise.all([
			opCount(ctx, inverse.resource, { filter }),
			opList(ctx, inverse.resource, {
				filter,
				limit,
				...relatedOrder(entry.resource),
			}),
		])
	} catch {
		// An unreadable child resource is simply omitted, not fatal.
		return null
	}
	return {
		resource: inverse.resource,
		label: entry.label,
		fk: inverse.column,
		count,
		rows,
		introspection: entry.resource,
		// So an FK on a *child* row renders its referenced record's title rather
		// than a raw uuid, exactly as it does on the child's own list. Resolved
		// outside the read's own catch: the rows are already in hand and gated, so
		// a failure to decorate them costs the titles, not the whole section.
		references: await resolveRowReferences(ctx, entry.resource, rows).catch(
			() => ({}),
		),
	}
}
