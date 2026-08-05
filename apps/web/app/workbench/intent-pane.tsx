/**
 * The first thing on the page: what you are trying to build.
 *
 * The surface used to open on the review queue, which is an answer to "what did my
 * agent do while I was away". That is a real question and it is the *second* one.
 * The first is the maintainer's own, and until this pane the product had no place
 * to put it: the agent handoff hands you a sentence about a node you already found,
 * and finding the node is the part that presumes you already know the shape of what
 * you are building.
 *
 * So: one box, one question, and the answer is written into the spec's product
 * layer as a requirement — see `intent.server.ts` for why it is a requirement and
 * what the write path is allowed to do. Two consequences worth stating on screen,
 * because both are the difference between this and a box that swallows text:
 *
 *   1. **It persists.** The sentence is in the spec, not in a chat scrollback.
 *   2. **The agent can read it.** `query_spec {section:"product"}` returns it, so
 *      the handoff points at the requirement id rather than pasting the prose
 *      again — one thing, not two copies that drift.
 *
 * Server-rendered, no client state. The form is a plain `<Form
 * method="post">`: it works before hydration, and it is a navigation, so the
 * recorded intent is on the page it lands on rather than appearing by effect.
 */

import { Form } from 'react-router'
import { AgentHandoff } from './agent-handoff'
import {
	type IntentView,
	MAX_INTENT_LENGTH,
	type RecordedIntent,
} from './intent'
import { actionClass, paneClass } from './shared'

function Recorded({ intent }: { intent: RecordedIntent }) {
	return (
		<li className="border-border/60 border-b py-1.5 last:border-b-0">
			<div className="text-[0.86rem]">{intent.story}</div>
			<div className="text-[0.72rem] text-muted-foreground">
				<code>{intent.id}</code>
				{intent.at ? ` · you recorded this ${intent.at}` : ' · from your PRD'}
			</div>
		</li>
	)
}

export function IntentPane({ view }: { view: IntentView }) {
	// Split, not merged. A project seeded from a PRD arrives with requirements
	// already in it, and rendering those as one list with the maintainer's own
	// would bury the question under six lines somebody else wrote — which is the
	// #256 failure exactly, one pane further down.
	const yours = view.intents.filter((i) => i.yours)
	const inherited = view.intents.filter((i) => !i.yours)
	const newest = yours[0]
	return (
		<section className={paneClass}>
			<h2 className="mt-0 text-base font-semibold">
				What are you trying to build?
			</h2>
			<p className="mt-0 mb-2 text-[0.82rem] text-muted-foreground">
				In your own words. It is written into your spec as a requirement, so
				your agent can read it — and so it is still here next week.
			</p>

			<Form method="post" className="mb-3">
				<input type="hidden" name="intent" value="record-intent" />
				<textarea
					name="story"
					rows={2}
					required
					maxLength={MAX_INTENT_LENGTH}
					placeholder="A place for my team to log client visits and see who is behind on follow-ups"
					className="w-full rounded-md border border-border bg-background p-2 text-[0.85rem]"
				/>
				<div className="mt-1 flex items-center gap-2">
					<button type="submit" className={actionClass('resolve')}>
						Record this
					</button>
					<span className="text-[0.72rem] text-muted-foreground">
						Nothing is built yet — recording it does not change your app.
					</span>
				</div>
			</Form>

			{newest ? (
				<>
					<ul className="m-0 list-none p-0">
						{yours.map((intent) => (
							<Recorded key={intent.id} intent={intent} />
						))}
					</ul>
					{/* Against the newest one, because that is the one somebody just
					    wrote and is about to act on. The older ones are context. */}
					<AgentHandoff
						className="mt-3"
						target={null}
						intent={{ id: newest.id, story: newest.story }}
					/>
				</>
			) : (
				<p className="mt-0 mb-2 text-[0.78rem] text-muted-foreground">
					Nothing recorded yet. This is also the fastest way to tell an agent
					what you want: say it here first, then hand it the sentence this pane
					gives you back.
				</p>
			)}

			{inherited.length > 0 ? (
				// Closed, and pure markup — everything here is already loaded, so this
				// disclosure hides nothing and costs nothing.
				<details className="mt-3">
					<summary className="cursor-pointer text-[0.78rem] text-muted-foreground">
						{inherited.length} requirement
						{inherited.length === 1 ? '' : 's'} already in your PRD
					</summary>
					<ul className="m-0 list-none p-0">
						{inherited.map((intent) => (
							<Recorded key={intent.id} intent={intent} />
						))}
					</ul>
				</details>
			) : null}
		</section>
	)
}
