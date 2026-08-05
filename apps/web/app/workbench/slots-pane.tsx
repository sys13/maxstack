/**
 * The slots pane — where bespoke UI can go, and what is already
 * there.
 *
 * The third surface of slot discovery, alongside `maxstack slots` and
 * `query_spec {section:"slots"}`; all three render `slotInventory()`, so a
 * human in the workbench and an agent calling the tool cannot be told different
 * things. Block slots are *derived* — there is no spec row and no generated
 * reference to grep — so if this pane did not exist, the only way to learn that
 * a bespoke card costs a slot fill rather than an eject would be to read the
 * source of the renderer.
 *
 * Fill state here comes from the running app's own owned-code manifest, not
 * from a directory scan: what the deployed bundle actually imports is the
 * honest answer to "is this filled", and it cannot drift from what renders.
 */

import type { SlotInventory } from '@maxstack/mcp'

export interface SlotsPaneProps {
	inventory: SlotInventory
}

export function SlotsPane({ inventory }: SlotsPaneProps) {
	const all = inventory.pages.flatMap((p) => p.slots)
	const filled = all.filter((s) => s.filled).length

	return (
		<section className="mt-5 rounded-lg border border-border p-4">
			<div className="flex items-baseline gap-3">
				<h2 className="m-0 text-lg font-semibold">Slots</h2>
				<p className="m-0 text-[0.8rem] text-foreground/70">
					{filled} of {all.length} filled · block roles v
					{inventory.rolesVersion} · fill one with{' '}
					<code className="font-mono">maxstack slots fill &lt;id&gt;</code>
				</p>
			</div>

			<p className="mt-2 text-[0.8rem] text-foreground/60">
				Bespoke UI without ejecting: a filled slot replaces one region and
				everything around it keeps regenerating.
			</p>

			{inventory.pages.map((page) =>
				page.slots.length === 0 ? null : (
					<div key={page.pageId} className="mt-3">
						<h3 className="m-0 text-[0.85rem] font-medium">
							{page.name}{' '}
							<span className="font-mono text-[0.75rem] text-foreground/60">
								{page.route}
							</span>
						</h3>
						<ul className="mt-1 flex flex-col gap-1">
							{page.slots.map((slot) => (
								<li
									key={slot.id}
									className="flex items-baseline gap-2 text-[0.8rem]"
								>
									{/* The glyph alone is not the status — a screen reader
									    should hear "filled", not "black circle". */}
									<span
										className={
											slot.filled ? 'text-foreground' : 'text-foreground/35'
										}
									>
										<span aria-hidden>{slot.filled ? '●' : '○'}</span>
										<span className="sr-only">
											{slot.filled ? 'filled' : 'available'}
										</span>
									</span>
									<code className="font-mono">{slot.id}</code>
									{slot.props ? (
										<span className="text-foreground/50">({slot.props})</span>
									) : null}
									<span className="truncate text-foreground/60">
										{slot.description}
									</span>
								</li>
							))}
						</ul>
					</div>
				),
			)}
		</section>
	)
}
