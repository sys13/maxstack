/**
 * The ownership drift pane — what you own, and what it is missing.
 *
 * The third surface of the drift fold, alongside `maxstack drift` and the
 * `ownership_drift` MCP tool. It exists because the eject tax is **deferred**:
 * you pay it silently, months later, when a framework improvement lands in every
 * generated route except the one you took. Without a pane, the only way to
 * discover that is to diff by hand against a file you no longer have.
 *
 * Deliberately not a nag. No badge, no count in the header, no "fix" button, and
 * `drifted` is rendered in the same voice as `in-sync` — an ejected file that has
 * diverged is a file doing exactly what ejecting it was for. Nothing here can
 * write; the loader's `Fs` throws on `write` so that is structural.
 */

import type { OwnershipDriftReport } from '@maxstack/core/ownership'

export interface DriftPaneProps {
	report: OwnershipDriftReport
}

const TONE: Record<string, string> = {
	'in-sync': 'text-foreground/60',
	authored: 'text-foreground/60',
	drifted: 'text-foreground/80',
	underived: 'text-foreground/60',
	missing: 'text-destructive',
}

export function DriftPane({ report }: DriftPaneProps) {
	return (
		<section className="mt-5 rounded-lg border border-border p-4">
			<div className="flex items-baseline gap-3">
				<h2 className="m-0 text-lg font-semibold">Ownership</h2>
				<p className="m-0 text-[0.8rem] text-foreground/70">
					{report.ownedCount} file(s) you own · see them with{' '}
					<code className="font-mono">maxstack drift --patches</code>
				</p>
			</div>

			<p className="mt-2 text-[0.8rem] text-foreground/60">
				What you own, what it was derived from, and how far it has drifted.
				Nothing here is applied and nothing here is a problem to fix — drift is
				the cost of owning a file, made visible instead of discovered in six
				months.
			</p>

			{report.ownedCount === 0 ? (
				<p className="mt-3 text-[0.8rem] text-foreground/60">
					You own nothing yet — no ejected files, no filled slots.
				</p>
			) : (
				<ul className="mt-3 flex flex-col gap-2">
					{report.owned.map((entry) => (
						<li key={entry.file} className="text-[0.8rem]">
							<div className="flex items-baseline gap-2">
								<span className="font-mono">{entry.file}</span>
								<span className={TONE[entry.status] ?? 'text-foreground/60'}>
									{entry.status}
								</span>
								<span className="text-foreground/50">({entry.ownership})</span>
								{entry.status === 'drifted' ? (
									<span className="text-foreground/50">
										+{entry.ahead} yours / −{entry.behind} theirs
									</span>
								) : null}
							</div>
							<p className="m-0 text-foreground/60">{entry.explanation}</p>
						</li>
					))}
				</ul>
			)}
		</section>
	)
}
