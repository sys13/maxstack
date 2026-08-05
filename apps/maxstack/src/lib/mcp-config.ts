/**
 * The project-local `.mcp.json` that lets Claude Code auto-discover the
 * maxstack MCP server with zero user action. Both `maxstack init`
 * (scaffold) and `maxstack dev` (self-heal older/hand-made projects) drop it,
 * so the hybrid onboarding — `maxstack init` then `cd && claude` — never asks
 * anyone to run `claude mcp add`.
 *
 * It registers a **stdio** server (`maxstack mcp`) that the agent client spawns
 * itself. It used to register an HTTP server at a pinned port, which only
 * answered while `maxstack dev` ran — and since clients connect at session
 * start, any session opened before `dev` came up silently had no tools at all
 *. Stdio removes the ordering, the port pinning, and the whole
 * cold-start failure mode.
 *
 * The command it registers is not a constant: it has to be one that resolves in
 * the *client's* process, which depends on how this CLI was installed. Under
 * `npx maxstack init` there is no `maxstack` on PATH, so a bare `maxstack` here
 * registers a server that can never start. `cliInvocation` supplies
 * the form that works — see `lib/invocation.ts`.
 */

import { resolve } from 'node:path'
import { type CliInvocation, currentInvocation } from './invocation.ts'

export const MCP_FILENAME = '.mcp.json'

/** The `.mcp.json` body registering the stdio server at `invocation`. */
export function mcpJson(invocation: CliInvocation): string {
	return `${JSON.stringify(
		{
			mcpServers: {
				maxstack: {
					command: invocation.command,
					args: [...invocation.prefix, 'mcp'],
				},
			},
		},
		null,
		'\t',
	)}\n`
}

/** The `.mcp.json` body for the CLI as it is running now. */
export async function mcpJsonContent(): Promise<string> {
	return mcpJson(await currentInvocation())
}

/** Write `.mcp.json` into a project root. */
export async function writeMcpJson(root: string): Promise<void> {
	const { writeFile } = await import('node:fs/promises')
	await writeFile(resolve(root, MCP_FILENAME), await mcpJsonContent())
}

/**
 * Write `.mcp.json` when it's missing — or when it still holds the superseded
 * HTTP registration — returning whether it was written. The self-heal path for
 * `maxstack dev`.
 *
 * A project scaffolded before the stdio switch points at
 * `http://127.0.0.1:3000/mcp`, which only answers while `dev` runs and strands
 * the session otherwise. That config is ours and is strictly worse, so we
 * upgrade it in place. Anything we don't recognize is hand-tuned and is left
 * alone.
 */
export async function ensureMcpJson(root: string): Promise<boolean> {
	const { access, readFile } = await import('node:fs/promises')
	const path = resolve(root, MCP_FILENAME)
	try {
		await access(path)
	} catch {
		await writeMcpJson(root)
		return true
	}
	if (await isSupersededHttpConfig(path, readFile)) {
		await writeMcpJson(root)
		return true
	}
	return false
}

/** Does this `.mcp.json` hold exactly the HTTP registration we used to ship? */
async function isSupersededHttpConfig(
	path: string,
	readFile: (p: string, enc: 'utf8') => Promise<string>,
): Promise<boolean> {
	try {
		const parsed = JSON.parse(await readFile(path, 'utf8')) as {
			mcpServers?: Record<string, { type?: string; url?: string }>
		}
		const servers = parsed.mcpServers ?? {}
		// Only when maxstack is the sole entry — a config that also registers
		// other servers is the user's, not ours to rewrite.
		if (Object.keys(servers).length !== 1) return false
		const entry = servers.maxstack
		return entry?.type === 'http' && (entry.url ?? '').includes('/mcp')
	} catch {
		// Unparseable or unreadable: not recognizably ours, so don't touch it.
		return false
	}
}

/** The `maxstack` server entry a `.mcp.json` registers, or null when it has
 * none (or the file is unreadable). Preflight reads this to check that the
 * command it names can actually be spawned. */
export async function readMcpRegistration(
	root: string,
): Promise<{ command: string; args: string[] } | null> {
	const { readFile } = await import('node:fs/promises')
	try {
		const parsed = JSON.parse(
			await readFile(resolve(root, MCP_FILENAME), 'utf8'),
		) as {
			mcpServers?: Record<string, { command?: unknown; args?: unknown }>
		}
		const entry = parsed.mcpServers?.maxstack
		if (!entry || typeof entry.command !== 'string') return null
		return {
			command: entry.command,
			args: Array.isArray(entry.args) ? (entry.args as string[]) : [],
		}
	} catch {
		return null
	}
}
