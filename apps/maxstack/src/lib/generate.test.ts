/**
 * `generateProject` over a spec that declares **two pages on one entity** —
 * issue #337, end to end through the CLI's own generation loop.
 *
 * The unit half of this lives in `packages/mcp/src/generators.test.ts`
 * (`pageDescriptors`); what is pinned here is the wiring, because the wiring is
 * what was broken. `generateProject` folded each page to its entity's resource
 * *independently*, so a list page and a board page over `e-book` both emitted
 * `routes/book.tsx`: every run overwrote the file it had just written, every run
 * reported `unsafe regen overwritten`, and `maxstack validate` could never pass
 * again — which also made a genuinely unsafe overwrite invisible, since every
 * run already looked unsafe.
 *
 * The assertion that matters is therefore not "two files exist" but
 * `isRegenStable` on a **second** run over an untouched tree.
 */

import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import { initCommand } from '../commands/init.ts'
import { opCommand } from '../commands/op.ts'
import { validateCommand } from '../commands/validate.ts'
import { generateProject, isRegenStable } from './generate.ts'
import { loadProject } from './project.ts'

const provenance = {
	isSuggested: false,
	isAccepted: true,
	isAddedManually: true,
	suggestedDescription: null,
	priority: 'medium' as const,
}

const entityOp = JSON.stringify({
	op: 'data.addEntity',
	args: {
		entity: {
			id: 'e-book',
			name: 'Book',
			description: 'A book on the shelf',
			provenance,
			fields: [
				{
					id: 'fld-title',
					name: 'title',
					type: 'string',
					required: true,
					provenance,
				},
			],
		},
	},
})

const pageOp = (id: string, name: string, route: string, block: string) =>
	JSON.stringify({
		op: 'page.addPage',
		args: {
			page: {
				id,
				name,
				route,
				entityId: 'e-book',
				provenance,
				blocks: [{ id: `blk-${id}`, type: block, provenance }],
			},
		},
	})

describe('generateProject — two pages over one entity (issue #337)', () => {
	let dir: string

	beforeAll(async () => {
		dir = await mkdtemp(join(tmpdir(), 'maxstack-gen-337-'))
		vi.spyOn(console, 'log').mockImplementation(() => {})
		vi.spyOn(console, 'error').mockImplementation(() => {})
		await initCommand(dir, { desc: 'a reading log', git: false })
		await opCommand(dir, { op: entityOp })
		await opCommand(dir, { op: pageOp('pg-books', 'Books', '/books', 'table') })
		await opCommand(dir, { op: pageOp('pg-shelf', 'Shelf', '/shelf', 'board') })
	}, 60_000)

	afterAll(async () => {
		vi.restoreAllMocks()
		await rm(dir, { recursive: true, force: true })
	})

	it('emits one route module per page and regenerates stably', async () => {
		const project = await loadProject(dir)

		const first = await generateProject(project)
		const routeFiles = first.writes
			.map((w) => w.file)
			.filter((f) => f.startsWith('routes/'))
		expect(routeFiles).toContain('routes/book.tsx')
		expect(routeFiles).toContain('routes/shelf.tsx')
		// The first page over the entity keeps the bare name it has always had, so
		// an existing project is not renamed out from under itself.
		expect(routeFiles).not.toContain('routes/books.tsx')

		// The gate: nothing this run wrote gets clobbered by the next one.
		const second = await generateProject(project)
		expect(isRegenStable(second.writes)).toBe(true)
		const unsafe = second.writes.filter(
			(w) => w.action !== 'unchanged' && w.action !== 'skipped-user-owned',
		)
		expect(unsafe).toEqual([])
	}, 60_000)
})

/**
 * Pruning — issue #338. Generation was add-and-overwrite only: nothing ever
 * walked from the manifest back to the spec and asked which entries the spec
 * still justifies, so a page removed from the spec left its route module on
 * disk, its line in `routes.ts` and its entry in `.generated.routes.json`
 * forever. In the project this was found in the leftover route 500'd on a
 * resource the app no longer had, and four `gen` runs had not removed it.
 *
 * The whole cycle is what is pinned here, because every step of it was intact
 * on its own: generate two pages, delete one from the spec, regenerate, and
 * check all three artifacts — then regenerate again, because a prune that is not
 * idempotent is a different bug wearing this one's fix.
 */
async function removePage(dir: string, pageId: string): Promise<void> {
	const project = await loadProject(dir)
	const spec = await project.spec.load()
	await project.spec.save({
		...spec,
		pages: {
			...spec.pages,
			pages: spec.pages.pages.filter((p) => p.id !== pageId),
		},
		// The op-log entry goes with it. There is no `page.removePage` op — a
		// deletion is a spec-file edit, which is exactly how it happened in the
		// project this was found in — and the codec reconstructs each `add` entry
		// from the state it points at, so an entry naming a page that is no longer
		// there fails to decode.
		opLog: spec.opLog.filter((entry) => entry.diff.targetId !== pageId),
	})
}

describe('generateProject — pruning a removed page (issue #338)', () => {
	let dir: string

	beforeAll(async () => {
		dir = await mkdtemp(join(tmpdir(), 'maxstack-gen-338-'))
		vi.spyOn(console, 'log').mockImplementation(() => {})
		vi.spyOn(console, 'error').mockImplementation(() => {})
		await initCommand(dir, { desc: 'a reading log', git: false })
		await opCommand(dir, { op: entityOp })
		await opCommand(dir, { op: pageOp('pg-books', 'Books', '/books', 'table') })
		await opCommand(dir, { op: pageOp('pg-shelf', 'Shelf', '/shelf', 'board') })
	}, 60_000)

	afterAll(async () => {
		vi.restoreAllMocks()
		await rm(dir, { recursive: true, force: true })
	})

	it('removes the module, the routes.ts line and the manifest entry', async () => {
		const project = await loadProject(dir)
		await generateProject(project)
		expect(await exists(dir, 'routes/shelf.tsx')).toBe(true)

		await removePage(dir, 'pg-shelf')
		const after = await generateProject(await loadProject(dir))

		expect(after.pruned).toEqual([
			expect.objectContaining({ file: 'routes/shelf.tsx', action: 'deleted' }),
		])
		// 1. the module.
		expect(await exists(dir, 'routes/shelf.tsx')).toBe(false)
		// 2. the route table.
		const routes = await appFile(dir, 'routes.ts')
		expect(routes).not.toContain('/shelf')
		expect(routes).not.toContain('shelf.tsx')
		expect(routes).toContain('/books')
		// 3. the ownership manifest.
		const manifest = JSON.parse(await appFile(dir, '.generated.routes.json'))
		expect(manifest.entries.map((e: { id: string }) => e.id)).not.toContain(
			'shelf',
		)

		// The page that survived is untouched — pruning removes what the spec
		// stopped justifying, not everything near it.
		expect(await exists(dir, 'routes/book.tsx')).toBe(true)

		// Idempotent: a second run finds nothing to prune and clobbers nothing.
		const second = await generateProject(await loadProject(dir))
		expect(second.pruned).toEqual([])
		expect(isRegenStable(second.writes)).toBe(true)
	}, 60_000)
})

describe('generateProject — the sibling inherits the bare module (issue #338)', () => {
	let dir: string

	beforeAll(async () => {
		dir = await mkdtemp(join(tmpdir(), 'maxstack-gen-338b-'))
		vi.spyOn(console, 'log').mockImplementation(() => {})
		vi.spyOn(console, 'error').mockImplementation(() => {})
		await initCommand(dir, { desc: 'a reading log', git: false })
		await opCommand(dir, { op: entityOp })
		await opCommand(dir, { op: pageOp('pg-books', 'Books', '/books', 'table') })
		await opCommand(dir, { op: pageOp('pg-shelf', 'Shelf', '/shelf', 'board') })
	}, 60_000)

	afterAll(async () => {
		vi.restoreAllMocks()
		await rm(dir, { recursive: true, force: true })
	})

	/**
	 * The case #337 deferred: module disambiguation is positional, so deleting the
	 * *first* page over an entity hands the bare `routes/book.tsx` to the survivor,
	 * which until now was emitting `routes/shelf.tsx`. The route path does not
	 * move — only the module underneath it does — so this is the case a
	 * prune-by-route-path would get wrong, and the case a prune that ran *after*
	 * emission would get wrong too (the insert would no-op against a `/shelf` line
	 * still pointing at the module about to be deleted).
	 */
	it('rewires the surviving page onto the module it inherits', async () => {
		await generateProject(await loadProject(dir))
		await removePage(dir, 'pg-books')
		const after = await generateProject(await loadProject(dir))

		// Two moves, one deletion: the retired module goes, and the survivor's
		// route table line is re-pointed at the module it just inherited.
		expect(after.pruned.map((p) => p.action).sort()).toEqual([
			'deleted',
			'repathed',
		])
		expect(await exists(dir, 'routes/shelf.tsx')).toBe(false)
		expect(await exists(dir, 'routes/book.tsx')).toBe(true)

		const routes = await appFile(dir, 'routes.ts')
		expect(routes).toContain(
			"{ path: '/shelf', file: './routes/book.tsx' }",
		)
		expect(routes).not.toContain('shelf.tsx')
		expect(routes).not.toContain('/books')

		// The inherited module renders the page that now owns it. (The `board`
		// block here carries no declaration, so the runtime skips it and renders
		// the page's list — and since #349 stage 2 the emitter mirrors that
		// instead of writing a placeholder over a page the runtime lists.)
		expect(await appFile(dir, 'routes/book.tsx')).toContain(
			'<h1 className="text-2xl font-semibold">Shelf</h1>',
		)

		const second = await generateProject(await loadProject(dir))
		expect(second.pruned).toEqual([])
		expect(isRegenStable(second.writes)).toBe(true)
	}, 60_000)
})

async function appFile(dir: string, path: string): Promise<string> {
	return readFile(join(dir, 'app', path), 'utf8')
}

async function exists(dir: string, path: string): Promise<boolean> {
	try {
		await readFile(join(dir, 'app', path), 'utf8')
		return true
	} catch {
		return false
	}
}

/**
 * The gate half of #338. `✔ manifest intact: N tracked files` verified the
 * entries it found — file present, hash unchanged — and never asked whether the
 * spec justified any of them, so a manifest tracking a route for a deleted page
 * was reported intact indefinitely. A stale entry IS intact; what is wrong with
 * it is that nothing declares it.
 */
describe('validate notices a manifest orphan (issue #338)', () => {
	let dir: string

	beforeAll(async () => {
		dir = await mkdtemp(join(tmpdir(), 'maxstack-val-338-'))
		vi.spyOn(console, 'log').mockImplementation(() => {})
		await initCommand(dir, { desc: 'a reading log', git: false })
		await opCommand(dir, { op: entityOp })
		await opCommand(dir, { op: pageOp('pg-books', 'Books', '/books', 'table') })
		await opCommand(dir, { op: pageOp('pg-shelf', 'Shelf', '/shelf', 'board') })
		await generateProject(await loadProject(dir))
		await removePage(dir, 'pg-shelf')
	}, 60_000)

	afterAll(async () => {
		vi.restoreAllMocks()
		await rm(dir, { recursive: true, force: true })
	})

	it('fails on a tracked route the spec does not declare', async () => {
		const errors: string[] = []
		const spy = vi
			.spyOn(console, 'error')
			.mockImplementation((...a: unknown[]) => {
				errors.push(a.join(' '))
			})
		const prev = process.exitCode
		process.exitCode = 0
		await validateCommand(dir)
		expect(process.exitCode).toBe(1)
		const text = errors.join('\n')
		expect(text).toMatch(/stale route: routes\/shelf\.tsx/)
		// It names the route, so the reader can tell which page they dropped.
		expect(text).toContain('/shelf')
		process.exitCode = prev
		spy.mockRestore()
	}, 60_000)
})

/**
 * Pruning the seam registries — issue #355, the wiring and the gate.
 *
 * The decision table is pinned in `packages/maxstack-core`'s
 * `prune-seams.test.ts` and the per-family cycle in `seam-prune.test.ts`; what
 * is pinned here is that `maxstack gen` and `maxstack validate` actually reach
 * them, through a real project on disk.
 *
 * Schedules, because the schedule registry is where the cost of getting this
 * wrong is highest: a stale route is inert until somebody navigates to it,
 * whereas a handler the runtime can still resolve is machinery pointed at
 * external systems.
 */
const scheduleOp = JSON.stringify({
	op: 'schedules.declare',
	args: {
		schedule: {
			id: 'sch-sweep',
			key: 'invoice.sweep',
			description: 'Issue and send recurring invoices',
			timezone: 'America/New_York',
			recurrence: { kind: 'monthly', onDayOfMonth: 28, atTime: '09:00' },
			runAs: { kind: 'service', role: 'billing' },
		},
	},
})

/** Undeclare every schedule, as a spec edit — there is no `undeclare` op. */
async function removeSchedules(dir: string): Promise<void> {
	const project = await loadProject(dir)
	const spec = await project.spec.load()
	await project.spec.save({
		...spec,
		// Emptied rather than deleted: `writeSpecDir` only writes the files it is
		// given, so setting the section to `undefined` leaves the old
		// `schedules.json` on disk and the next load reads it straight back.
		schedules: { schedules: [] },
		// Same reason as `removePage`: the codec reconstructs each `declare` entry
		// from the state it points at, so an entry naming a schedule that is no
		// longer there fails to decode.
		opLog: spec.opLog.filter((entry) => entry.diff.targetId !== 'sch-sweep'),
	})
}

describe('generateProject — pruning an undeclared schedule (issue #355)', () => {
	let dir: string

	beforeAll(async () => {
		dir = await mkdtemp(join(tmpdir(), 'maxstack-gen-355-'))
		vi.spyOn(console, 'log').mockImplementation(() => {})
		vi.spyOn(console, 'error').mockImplementation(() => {})
		await initCommand(dir, { desc: 'a billing app', git: false })
		await opCommand(dir, { op: entityOp })
		await opCommand(dir, { op: pageOp('pg-books', 'Books', '/books', 'table') })
		await opCommand(dir, { op: scheduleOp })
	}, 60_000)

	afterAll(async () => {
		vi.restoreAllMocks()
		await rm(dir, { recursive: true, force: true })
	})

	it('unregisters the registry and leaves the handler alone', async () => {
		await generateProject(await loadProject(dir))
		const handler = 'jobs/invoice-sweep.handler.ts'
		expect(await exists(dir, 'jobs/schedules.generated.ts')).toBe(true)
		expect(await exists(dir, handler)).toBe(true)
		await writeFile(
			join(dir, 'app', handler),
			'// the billing run, by hand\n',
			'utf8',
		)

		await removeSchedules(dir)
		const after = await generateProject(await loadProject(dir))

		// The registry goes. Undeclaring the LAST schedule is the case
		// regeneration could never fix: every seam generator early-returns on an
		// empty descriptor list ("no declaration, no directory"), and an early
		// return writes nothing at all.
		expect(after.pruned).toContainEqual(
			expect.objectContaining({
				file: 'jobs/schedules.generated.ts',
				action: 'deleted',
			}),
		)
		expect(await exists(dir, 'jobs/schedules.generated.ts')).toBe(false)
		const manifest = JSON.parse(await appFile(dir, '.generated.routes.json'))
		const ids = manifest.entries.map((e: { id: string }) => e.id)
		// Without the entry, `owned.generated.tsx` re-exports an empty map and the
		// job queue registers no handler for the retired key.
		expect(ids).not.toContain('schedules:registry')

		// The handler is untouched, still tracked, and reported rather than
		// silently orphaned — it is the maintainer's code, which is the point.
		expect(await appFile(dir, handler)).toBe('// the billing run, by hand\n')
		expect(ids).toContain('schedule:invoice.sweep:slot')
		expect(after.pruned).toContainEqual(
			expect.objectContaining({ file: handler, action: 'kept-owned' }),
		)

		// A prune that is not idempotent is a different bug wearing this one's fix.
		const second = await generateProject(await loadProject(dir))
		expect(second.pruned.every((p) => p.action === 'kept-owned')).toBe(true)
		expect(isRegenStable(second.writes)).toBe(true)
		expect(await appFile(dir, handler)).toBe('// the billing run, by hand\n')
	}, 60_000)
})

describe('validate notices a stale seam registry (issue #355)', () => {
	let dir: string

	beforeAll(async () => {
		dir = await mkdtemp(join(tmpdir(), 'maxstack-val-355-'))
		vi.spyOn(console, 'log').mockImplementation(() => {})
		await initCommand(dir, { desc: 'a billing app', git: false })
		await opCommand(dir, { op: entityOp })
		await opCommand(dir, { op: pageOp('pg-books', 'Books', '/books', 'table') })
		await opCommand(dir, { op: scheduleOp })
		await generateProject(await loadProject(dir))
		await removeSchedules(dir)
	}, 60_000)

	afterAll(async () => {
		vi.restoreAllMocks()
		await rm(dir, { recursive: true, force: true })
	})

	it('fails on a tracked registry the spec no longer needs', async () => {
		const errors: string[] = []
		const spy = vi
			.spyOn(console, 'error')
			.mockImplementation((...a: unknown[]) => {
				errors.push(a.join(' '))
			})
		const prev = process.exitCode
		process.exitCode = 0
		await validateCommand(dir)
		expect(process.exitCode).toBe(1)
		expect(errors.join('\n')).toMatch(
			/stale schedule registry: jobs\/schedules\.generated\.ts/,
		)
		process.exitCode = prev
		spy.mockRestore()
	}, 60_000)
})
