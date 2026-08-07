/**
 * Issue #279 — who the stdio MCP host says landed an op.
 *
 * #279 was filed as "the published CLI has no origin support at all"; by the
 * time it was verified the CLI half had shipped (0.11.12 stamps `origin: "ai"`
 * and `agent: "claude-code"` from a Claude Code shell). What had NOT shipped was
 * the same answer on the other surface: driven from the identical environment,
 *
 *   CLI  →  actor {surface: "cli", path: "cli-add-field",
 *                  agent: "my-bot", session: "sess-1"}
 *   MCP  →  actor {surface: "mcp", path: "mcp-apply-spec-change"}
 *
 * — no agent, no session, no key id, on the busiest agent write path in the
 * product. `@maxstack/mcp` spreads `ctx.actor` onto every op it lands; this host
 * simply never supplied one, so the field was structurally optional and
 * permanently empty. Reviewing forty proposals is a different job when the trail
 * cannot say they came from one agent run.
 *
 * These are AGREEMENT tests: the MCP host's identity is compared against
 * `resolveActor`'s — the CLI's own answer for the same env — rather than against
 * a restated literal, so the two surfaces cannot drift apart while both look
 * individually correct.
 */

import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
	createInMemorySpecStore,
	defaultCheckRunner,
	executePlatformTool,
} from '@maxstack/mcp'
import { newSpecSystem, type SpecSystem } from '@maxstack/spec'
import { tasklyPRD } from '@maxstack/spec/fixtures'
import { afterEach, describe, expect, it } from 'vitest'
import { resolveActor } from '../lib/origin.ts'
import { DEFAULT_CONFIG, type Project } from '../lib/project.ts'
import { platformContext } from './mcp.ts'

/** The environment a Claude Code session hands a server it spawned. */
const AGENT_ENV = {
	CLAUDECODE: '1',
	MAXSTACK_AGENT: 'my-bot',
	MAXSTACK_SESSION: 'sess-1',
	MAXSTACK_KEY_ID: 'key-1',
} satisfies NodeJS.ProcessEnv

const dirs: string[] = []

afterEach(async () => {
	for (const d of dirs.splice(0)) await rm(d, { recursive: true, force: true })
})

async function tempProject(spec: SpecSystem): Promise<Project> {
	const root = await mkdtemp(join(tmpdir(), 'maxstack-mcp-actor-'))
	dirs.push(root)
	return {
		root,
		appPath: root,
		specDir: join(root, 'spec'),
		config: { ...DEFAULT_CONFIG, appDir: '.', name: 'attribution' },
		spec: createInMemorySpecStore(spec),
	}
}

async function hostFor(env: NodeJS.ProcessEnv) {
	const project = await tempProject(newSpecSystem(tasklyPRD))
	return {
		project,
		ctx: platformContext(project, defaultCheckRunner(), env),
	}
}

describe('the stdio MCP host declares who is driving', () => {
	it('stamps origin "ai" from the transport, never from MAXSTACK_ORIGIN', async () => {
		// The transport IS the signal here: nothing reaches a stdio server except
		// the agent client that spawned it. The CLI consults `MAXSTACK_ORIGIN`
		// because a shelled-out `maxstack add-field` is indistinguishable from a
		// person typing one; this surface has no such ambiguity, so an env var must
		// not be able to talk it into hiding an agent's work from review.
		const { ctx } = await hostFor({ ...AGENT_ENV, MAXSTACK_ORIGIN: 'human' })
		expect(ctx.origin).toBe('ai')
	})

	it('carries the same identity the CLI would record for the same shell', async () => {
		const { ctx } = await hostFor(AGENT_ENV)
		const { surface, path, ...cliIdentity } = resolveActor(
			{ path: 'cli-add-field' },
			AGENT_ENV,
		)
		expect(surface).toBe('cli')
		expect(path).toBe('cli-add-field')
		expect(ctx.actor).toEqual(cliIdentity)
		// Guard the pin itself: an agreement between two empty objects would pass
		// this while proving nothing, which is the bug being closed.
		expect(cliIdentity).toEqual({
			agent: 'my-bot',
			session: 'sess-1',
			keyId: 'key-1',
		})
	})

	it('records no identity rather than a placeholder when nothing identifies itself', async () => {
		const { ctx } = await hostFor({})
		expect(ctx.actor).toEqual({})
	})

	it('reaches the op log — an applied op names the agent and the session', async () => {
		// The end of the wire, not just the context object: `apply_spec_change` is
		// the path #279 is about, and it is what a reviewer actually reads.
		const { project, ctx } = await hostFor(AGENT_ENV)
		const result = await executePlatformTool(ctx, 'apply_spec_change', {
			op: 'data.addEntity',
			args: {
				entity: {
					id: 'e-bottle',
					name: 'Bottle',
					fields: [
						{ id: 'fld-name', name: 'name', type: 'string', required: true },
					],
				},
			},
		})
		expect(result.isError).toBeFalsy()

		const spec = await project.spec.load()
		const applied = spec.opLog[spec.opLog.length - 1]
		expect(applied?.origin).toBe('ai')
		expect(applied?.actor).toEqual({
			surface: 'mcp',
			path: 'mcp-apply-spec-change',
			agent: 'my-bot',
			session: 'sess-1',
			keyId: 'key-1',
		})
	})
})
