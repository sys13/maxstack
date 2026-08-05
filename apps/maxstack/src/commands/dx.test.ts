/**
 * The DX surface added for issues #18–#22, over a real temp project:
 *   - #20 the `add-entity`/`add-field` sugar compiles to the same ops;
 *   - #18 `--accept`/`--gen` (and `reviewMode: "auto"`) collapse land→accept→gen;
 *   - #21 `eject --dry-run` previews without flipping ownership;
 *   - #22 `init` drops `.mcp.json` + `.claude/skills`.
 */

import { access, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { readSpecDir } from '@maxstack/mcp'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import {
	addEntityCommand,
	addFieldCommand,
	addPageCommand,
} from './add-entity.ts'
import { ejectCommand } from './eject.ts'
import { initCommand } from './init.ts'
import { opCommand } from './op.ts'

async function readJson(path: string): Promise<any> {
	return JSON.parse(await readFile(path, 'utf8'))
}

async function exists(path: string): Promise<boolean> {
	try {
		await access(path)
		return true
	} catch {
		return false
	}
}

/** Pin a scaffolded project's review mode, for suites that exercise the queue. */
async function setReviewMode(
	dir: string,
	mode: 'review' | 'auto',
): Promise<void> {
	const path = join(dir, 'maxstack.json')
	const config = JSON.parse(await readFile(path, 'utf8'))
	config.reviewMode = mode
	await writeFile(path, `${JSON.stringify(config, null, '\t')}\n`)
}

describe('maxstack DX verbs (issues 18–22)', () => {
	let dir: string
	// Load the spec through the store so the compact `spec/` dir is decoded (and
	// slimmed op-log entries are rebuilt) exactly as the runtime sees it. Typed
	// loosely (this suite pokes at `op.args` across the op union, as before).
	const loadSpec = (): Promise<any> => readSpecDir(join(dir, 'spec'))

	beforeAll(async () => {
		dir = await mkdtemp(join(tmpdir(), 'maxstack-dx-'))
		vi.spyOn(console, 'log').mockImplementation(() => {})
		vi.spyOn(console, 'error').mockImplementation(() => {})
		vi.spyOn(console, 'warn').mockImplementation(() => {})
		await initCommand(dir, { desc: 'a DX test app' })
		// This suite is about the review queue, so it pins the mode it exercises
		// rather than riding on whatever the default happens to be. (The default
		// itself is asserted below, against its own fresh scaffold.)
		await setReviewMode(dir, 'review')
	})

	afterAll(async () => {
		vi.restoreAllMocks()
		await rm(dir, { recursive: true, force: true })
	})

	// --- #22 onboarding ------------------------------------------------------

	it('init emits a stdio .mcp.json and the .claude skills', async () => {
		const mcp = await readJson(join(dir, '.mcp.json'))
		// Stdio: the client spawns the server itself, so `mcp__maxstack__*` is in
		// every session. The old http registration only answered while
		// `maxstack dev` ran, which is the whole cold-start problem.
		expect(mcp.mcpServers.maxstack.command).toBe('maxstack')
		expect(mcp.mcpServers.maxstack.args).toEqual(['mcp'])
		expect(
			await exists(join(dir, '.claude/skills/plan-and-scope/SKILL.md')),
		).toBe(true)
	})

	it('the scaffolded CLAUDE.md leads with MCP and states the discoverable-only facts', async () => {
		// A real session with these tools available drove everything through bash
		// instead, because the briefing opened with the CLI and filed MCP under
		// "only when dev is running". It then burned ~18 shell commands
		// rediscovering the field types (concluding, wrongly, that the CLI sugar
		// `text` was canonical) and the owned-route contract.
		const text = await readFile(join(dir, 'CLAUDE.md'), 'utf8')
		expect(text).toContain('use the MCP tools')
		expect(text).not.toContain('only when `dev` is running')
		// The canonical six, and the sugar called out as sugar.
		for (const type of [
			'string',
			'number',
			'boolean',
			'date',
			'enum',
			'json',
		]) {
			expect(text, type).toContain(`\`${type}\``)
		}
		expect(text).toContain('sugar, not a type')
		// The owned-route contract an agent otherwise reads runtime source to find.
		expect(text).toContain('no props')
		expect(text).toContain('/api/<resource>')
		expect(text).toContain('maxstack dev --owned')
	})

	it('the scaffolded CLAUDE.md draws the runtime/spec boundary', async () => {
		// Three shipped defects in a row lived in the prebuilt runtime, and agents
		// (and humans) audited their own five-op spec for them — a bundle they
		// could not see, in a package this project cannot change. The briefing has
		// to name the boundary, name the reporting path, and forbid the two
		// workarounds that get reached for instead (eject / hand-written app).
		const text = await readFile(join(dir, 'CLAUDE.md'), 'utf8')
		expect(text).toContain('runtime bug')
		expect(text).toContain('maxstack doctor')
		expect(text).toContain('github.com/sys13/maxstack/issues')
		expect(text).toContain('nothing in this project can change it')
	})

	it('ships a build-app skill whose description triggers on plain build requests', async () => {
		// The load-bearing part is the frontmatter `description` — it is the only
		// thing that decides whether the skill fires. The three original skills
		// are all scoping/backlog-framed, so none of them matched the dogfood
		// prompt ("build out a simple reading list app … make it look beautiful")
		// and the agent proceeded with no procedural guidance at all.
		const text = await readFile(
			join(dir, '.claude/skills/build-app/SKILL.md'),
			'utf8',
		)
		const description = /^description:\s*(.+)$/m.exec(text)?.[1] ?? ''
		for (const trigger of ['build', 'add', 'page', 'beautiful']) {
			expect(description.toLowerCase(), trigger).toContain(trigger)
		}
		// The ladder that keeps "make it beautiful" from becoming an instant eject.
		// Rung 1: theme + list variant are spec ops, before any slot/eject.
		expect(text).toContain('theme.set')
		expect(text).toContain('page.setBlockVariant')
		// Rung 2: which fields the list shows is a spec op too.
		expect(text).toContain('page.setBlockFields')
		expect(text).toContain('.slots.tsx')
		expect(text).toContain('maxstack eject')
		// #104: verification honesty — never report REST coverage as UI coverage.
		expect(text).toContain('REST layer confirmed')
		// CLAUDE.md is the always-on layer that has to point at the skill.
		const claudeMd = await readFile(join(dir, 'CLAUDE.md'), 'utf8')
		expect(claudeMd).toContain('build-app')
	})

	it('scaffolded skills keep a CLI fallback for a failed MCP registration', async () => {
		// The tools now come from a stdio server the client spawns itself, so the
		// old cold-start framing ("started before the server, nothing you can do
		// this session") is obsolete — absence means the registration failed. The
		// CLI fallback still has to be sanctioned, so an agent never hand-edits
		// spec files to route around it.
		for (const skill of ['plan-and-scope', 'run-next-task', 'ship-check']) {
			const text = await readFile(
				join(dir, `.claude/skills/${skill}/SKILL.md`),
				'utf8',
			)
			expect(text, skill).toContain('If the tools are absent')
			expect(text, skill).toMatch(/maxstack (op|validate)/)
			// The stale premise must not survive anywhere.
			expect(text, skill).not.toContain('register at session start')
		}
	})

	it('run-next-task works without a TASKS.md', async () => {
		// `init` ships the skill but never writes `TASKS.md` (only `new` does), so
		// the skill must not hard-require the file: absent, it derives the backlog
		// from the spec's requirements instead of failing at step 1.
		const text = await readFile(
			join(dir, '.claude/skills/run-next-task/SKILL.md'),
			'utf8',
		)
		expect(text).toContain('`TASKS.md` is optional')
		expect(text).toContain('query_spec {section:"requirements"}')
		// And init still intentionally doesn't scaffold the file.
		await expect(access(join(dir, 'TASKS.md'))).rejects.toThrow()
	})

	it('init defaults reviewMode to auto', async () => {
		// Its own scaffold: the shared fixture above deliberately overrides this.
		const fresh = await mkdtemp(join(tmpdir(), 'maxstack-dx-default-'))
		try {
			await initCommand(fresh, { desc: 'a default-mode app' })
			const config = await readJson(join(fresh, 'maxstack.json'))
			expect(config.reviewMode).toBe('auto')
		} finally {
			await rm(fresh, { recursive: true, force: true })
		}
	})

	// --- #20 sugar -----------------------------------------------------------

	it('add-entity compiles the field DSL to a data.addEntity op', async () => {
		await addEntityCommand(dir, 'task', {
			field: ['title:text!', 'done:bool', 'priority:enum(low,high)'],
		})
		const spec = await loadSpec()
		const task = spec.data.entities.find((e: any) => e.id === 'e-task')
		expect(task.name).toBe('Task')
		expect(task.fields.map((f: any) => `${f.name}:${f.type}`)).toEqual([
			'title:string',
			'done:boolean',
			'priority:enum',
		])
		const title = task.fields[0]
		expect(title.required).toBe(true)
		expect(task.fields[2].options).toHaveLength(2)
		// The op log recorded the compiled data.addEntity op.
		expect(spec.opLog.at(-1).op.op).toBe('data.addEntity')
	})

	it('add-entity without accept logs no provenance.review op (review mode)', async () => {
		const spec = await loadSpec()
		// The DSL row is manual() (already accepted); the point is that no extra
		// provenance.review op was logged when --accept wasn't requested.
		expect(spec.opLog.some((o: any) => o.op.op === 'provenance.review')).toBe(
			false,
		)
	})

	it('add-field targets an entity by bare slug or full id', async () => {
		await addFieldCommand(dir, 'task', 'dueOn:date!', {})
		await addFieldCommand(dir, 'e-task', 'notes:text', {})
		const spec = await loadSpec()
		const task = spec.data.entities.find((e: any) => e.id === 'e-task')
		expect(task.fields.map((f: any) => f.name)).toContain('dueOn')
		expect(task.fields.map((f: any) => f.name)).toContain('notes')
	})

	it('add-entity requires at least one field', async () => {
		await expect(addEntityCommand(dir, 'empty', { field: [] })).rejects.toThrow(
			/at least one --field/,
		)
	})

	// --- #95 add-page sugar --------------------------------------------------

	it('add-page compiles to a page.addPage op with sensible defaults', async () => {
		await addPageCommand(dir, 'task', {})
		const spec = await loadSpec()
		const page = spec.pages.pages.find((p: any) => p.id === 'pg-task')
		expect(page.name).toBe('Task')
		expect(page.route).toBe('/task')
		expect(page.entityId).toBe('e-task')
		expect(page.blocks.map((b: any) => b.type)).toEqual(['table'])
		expect(spec.opLog.at(-1).op.op).toBe('page.addPage')
	})

	it('add-page honors --name/--route/--id and normalizes them', async () => {
		await addPageCommand(dir, 'e-task', {
			name: 'Today',
			route: 'today', // no leading slash → normalized
			id: 'today', // no pg- prefix → normalized
		})
		const spec = await loadSpec()
		const page = spec.pages.pages.find((p: any) => p.id === 'pg-today')
		expect(page.name).toBe('Today')
		expect(page.route).toBe('/today')
		expect(page.entityId).toBe('e-task')
	})

	// --- #102 add-entity --with-page -----------------------------------------

	it('add-entity --with-page lands the entity and a default page in one shot', async () => {
		const before = await loadSpec()
		await addEntityCommand(dir, 'book', {
			field: ['title:text!', 'status:enum(want,reading,done)'],
			withPage: true,
		})
		const spec = await loadSpec()
		const entity = spec.data.entities.find((e: any) => e.id === 'e-book')
		expect(entity.fields.map((f: any) => f.name)).toEqual(['title', 'status'])
		const page = spec.pages.pages.find((p: any) => p.id === 'pg-book')
		expect(page.route).toBe('/book')
		expect(page.entityId).toBe('e-book')
		expect(page.blocks.map((b: any) => b.type)).toEqual(['table'])
		// One land: exactly the two compiled ops appended, in order.
		expect(spec.opLog.length).toBe(before.opLog.length + 2)
		expect(spec.opLog.at(-2).op.op).toBe('data.addEntity')
		expect(spec.opLog.at(-1).op.op).toBe('page.addPage')
	})

	it('add-entity --with-page honors --route/--page-id/--page-name passthroughs', async () => {
		await addEntityCommand(dir, 'note', {
			field: ['body:text!'],
			withPage: true,
			route: 'notes', // no leading slash → normalized
			pageId: 'jots', // no pg- prefix → normalized
			pageName: 'All Notes',
		})
		const spec = await loadSpec()
		const page = spec.pages.pages.find((p: any) => p.id === 'pg-jots')
		expect(page.route).toBe('/notes')
		expect(page.name).toBe('All Notes')
		expect(page.entityId).toBe('e-note')
	})

	// --- #141 op-log origin --------------------------------------------------

	it('stamps --origin ai on the op log (and the row reads as AI-suggested)', async () => {
		await addEntityCommand(dir, 'draft', {
			field: ['title:text!'],
			origin: 'ai',
		})
		const spec = await loadSpec()
		expect(spec.opLog.at(-1).origin).toBe('ai')
		// origin drives the default provenance: an AI-authored row lands accepted
		// but stays visibly AI-suggested, rather than manual().
		const entity = spec.data.entities.find((e: any) => e.id === 'e-draft')
		expect(entity.provenance.isSuggested).toBe(true)
		expect(entity.provenance.isAccepted).toBe(true)
	})

	it('stamps --origin human explicitly, even under an agent shell', async () => {
		process.env.CLAUDECODE = '1'
		try {
			await addEntityCommand(dir, 'memo', {
				field: ['title:text!'],
				origin: 'human',
			})
		} finally {
			process.env.CLAUDECODE = undefined
			delete process.env.CLAUDECODE
		}
		const spec = await loadSpec()
		expect(spec.opLog.at(-1).origin).toBe('human')
		const entity = spec.data.entities.find((e: any) => e.id === 'e-memo')
		expect(entity.provenance.isAddedManually).toBe(true)
	})

	it('carries the origin onto the --accept cascade too', async () => {
		await addEntityCommand(dir, 'clip', {
			field: ['title:text!'],
			origin: 'ai',
			accept: true,
		})
		const spec = await loadSpec()
		const review = spec.opLog.at(-1)
		expect(review.op.op).toBe('provenance.review')
		expect(review.origin).toBe('ai')
	})

	it('rejects an unknown --origin before touching the spec', async () => {
		const before = await loadSpec()
		await expect(
			addEntityCommand(dir, 'nope', {
				field: ['title:text!'],
				origin: 'robot',
			}),
		).rejects.toThrow(/--origin "robot"/)
		expect((await loadSpec()).opLog.length).toBe(before.opLog.length)
	})

	// --- #18 accept + gen ----------------------------------------------------

	it('op --accept logs a cascading provenance.review; --gen regenerates', async () => {
		const before = await loadSpec()
		await opCommand(dir, {
			op: JSON.stringify({
				op: 'page.addPage',
				args: {
					page: {
						id: 'pg-tasks',
						name: 'Tasks',
						route: '/tasks',
						entityId: 'e-task',
						provenance: {
							isSuggested: true,
							isAccepted: null,
							isAddedManually: false,
							suggestedDescription: null,
							priority: 'high',
						},
						blocks: [
							{
								id: 'blk-t',
								type: 'table',
								provenance: {
									isSuggested: true,
									isAccepted: null,
									isAddedManually: false,
									suggestedDescription: null,
									priority: 'medium',
								},
							},
						],
					},
				},
			}),
			accept: true,
			gen: true,
		})
		const after = await loadSpec()
		const page = after.pages.pages.find((p: any) => p.id === 'pg-tasks')
		expect(page.provenance.isAccepted).toBe(true) // accepted by the cascade
		expect(page.blocks[0].provenance.isAccepted).toBe(true) // cascade reached the block
		expect(after.opLog.at(-1).op.op).toBe('provenance.review')
		expect(after.opLog.length).toBe(before.opLog.length + 2) // addPage + review
		// --gen produced the route tree.
		expect(await exists(join(dir, 'app/routes/task.tsx'))).toBe(true)
	})

	it('reviewMode "auto" accepts + gens with no flags', async () => {
		const config = await readJson(join(dir, 'maxstack.json'))
		config.reviewMode = 'auto'
		await writeFile(
			join(dir, 'maxstack.json'),
			JSON.stringify(config, null, '\t'),
		)

		await addEntityCommand(dir, 'widget', { field: ['name:text!'] })
		const spec = await loadSpec()
		// The last op is the auto-accept review of the widget entity.
		const last = spec.opLog.at(-1)
		expect(last.op.op).toBe('provenance.review')
		expect(last.op.args.target.id).toBe('e-widget')

		// restore for any later assertions
		config.reviewMode = 'review'
		await writeFile(
			join(dir, 'maxstack.json'),
			JSON.stringify(config, null, '\t'),
		)
	})

	// --- #21 eject --dry-run -------------------------------------------------

	it('eject --dry-run previews without flipping ownership', async () => {
		const manifestPath = join(dir, 'app/.generated.routes.json')
		const before = await readFile(manifestPath, 'utf8')
		await ejectCommand(dir, 'task', { dryRun: true })
		expect(await readFile(manifestPath, 'utf8')).toBe(before) // untouched
		const manifest = JSON.parse(before)
		expect(manifest.entries.find((e: any) => e.id === 'task').ownership).toBe(
			'generated',
		)
	})

	it('eject (for real) flips ownership after the dry-run', async () => {
		await ejectCommand(dir, 'task', {})
		const manifest = await readJson(join(dir, 'app/.generated.routes.json'))
		expect(manifest.entries.find((e: any) => e.id === 'task').ownership).toBe(
			'ejected',
		)
	})
})
