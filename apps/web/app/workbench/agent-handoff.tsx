/**
 * "How do I actually change this?" — the answer the workbench never gave
 * (*"it's not clear how to integrate with AI and actually getting
 * things done and improved and changed"*).
 *
 * The honest answer is that this surface does not make changes. It reviews
 * them. Changes are made by an agent calling `propose_spec_change` /
 * `apply_spec_change` over MCP, or by `maxstack` on the command line — and the
 * workbench's job is to hand you the exact sentence that starts that, already
 * naming the node you are looking at, so the round trip through "what is this
 * thing called again?" disappears.
 *
 * Deliberately *not* a prompt box that calls a model from the loader. An AI
 * call must never fire as a side effect of a page (the same rule
 * `ai-cluster.server.ts` is built around), and a box that silently did one
 * would also be claiming this surface owns a write path it does not own.
 */

import { useState } from 'react'
import { actionClass } from './shared'

export interface HandoffTarget {
	/** entity / page / field… — what the agent should be told it is. */
	kind: string
	/** The node's human name, as the agent will recognise it. */
	label: string
}

/**
 * The sentence to say to an agent that has the maxstack MCP server attached.
 *
 * Three shapes, in the order they became true:
 *
 *   - **A node** — "look at the `page` Tasks and propose a change". The original:
 *     it removes the round trip through "what is this thing called again?".
 *   - **An intent** — the maintainer's own sentence about what they are trying to
 *     build, handed over as the frame. The agent is pointed at the recorded
 *     requirement rather than at the prose, because the prose is in the spec and
 *     the id is how it stays one thing rather than two copies that drift.
 *   - **Neither** — the bare opener.
 */
export function handoffPrompt(
	target: HandoffTarget | null,
	intent?: { id: string; story: string },
): string {
	if (intent)
		return `Using the maxstack MCP tools, read requirement ${intent.id} in my spec — "${intent.story}" — and propose the changes that get me there: `
	if (!target)
		return 'Using the maxstack MCP tools, propose a change to my app spec: '
	return `Using the maxstack MCP tools, look at the ${target.kind} "${target.label}" in my spec and propose a change: `
}

function CopyButton({ text }: { text: string }) {
	// `idle` on both server and client, so the first paint matches.
	const [copied, setCopied] = useState(false)
	return (
		<button
			type="button"
			className={actionClass('neutral')}
			onClick={() => {
				void navigator.clipboard?.writeText(text).then(
					() => setCopied(true),
					// Clipboard access can be denied; saying nothing would look like a
					// silent success, which is the one outcome worth avoiding.
					() => setCopied(false),
				)
			}}
		>
			{copied ? 'Copied' : 'Copy'}
		</button>
	)
}

export function AgentHandoff({
	target,
	intent,
	className,
}: {
	target: HandoffTarget | null
	/** A recorded intent to hand over instead of a node (see `intent.server.ts`). */
	intent?: { id: string; story: string }
	className?: string
}) {
	const prompt = handoffPrompt(target, intent)
	return (
		<div
			className={`rounded-md border border-dashed border-border p-3 ${className ?? ''}`}
		>
			<h3 className="mt-0 mb-1 text-[0.85rem] font-semibold">
				{intent
					? 'Hand this to your agent'
					: target
						? `Change ${target.label}`
						: 'Change something'}
			</h3>
			<p className="mt-0 mb-2 text-[0.78rem] text-muted-foreground">
				Changes are made by your agent, not here. Say this to it — then come
				back and the proposal will be waiting for your OK.
			</p>
			<div className="flex items-start gap-2">
				<code className="min-w-0 flex-1 rounded bg-muted px-2 py-1.5 text-[0.75rem] break-words">
					{prompt}
					<span className="text-muted-foreground">…what you want</span>
				</code>
				<CopyButton text={prompt} />
			</div>
			{/* Named tools and verbs only — `maxstack propose` read well here and
			    does not exist, which is exactly the kind of confident-wrong pointer
			    that costs someone their afternoon. */}
			<p className="mt-2 mb-0 text-[0.72rem] text-muted-foreground">
				No agent attached? <code>maxstack mcp</code> serves the same tools to
				any MCP client, and <code>maxstack op</code> applies a typed change
				straight from the terminal.
			</p>
		</div>
	)
}
