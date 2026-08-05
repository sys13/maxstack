/**
 * The flags pane — every declared flag, what it gates, how old it
 * is, when it was last evaluated, and whether anything about it says "retire
 * me".
 *
 * This is the visibility half of the feature. A flag hidden in application code
 * is a flag nobody audits: the reviewer cannot see that a page is gated, and
 * nobody can answer "which of these still matter?" without a code search. The
 * spec knows the declarations and the gates; the telemetry table knows the use;
 * this pane is the two of them in one table, with the op that acts on it named
 * in the empty-ish case rather than left as an exercise.
 */

import type { StaleFlagRow } from '@maxstack/features/flags'

export interface FlagsPaneProps {
	all: StaleFlagRow[]
	stale: StaleFlagRow[]
}

const REASON_LABELS: Record<string, string> = {
	'gates-nothing': 'gates nothing',
	'never-evaluated': 'never evaluated',
	'not-evaluated-recently': 'not evaluated recently',
	'rollout-complete': 'rollout complete',
}

function Reasons({ reasons }: { reasons: StaleFlagRow['reasons'] }) {
	if (reasons.length === 0) return <span className="text-foreground/50">—</span>
	return (
		<span className="flex flex-wrap gap-1">
			{reasons.map((reason, i) => (
				<span
					// biome-ignore lint/suspicious/noArrayIndexKey: the value alone is not unique and there is no id on this row; the list is loader-rendered and never reordered client-side, so value:index is stable
					key={`${reason}:${i}`}
					className="rounded-full border border-border px-2 py-0.5 text-[0.7rem] text-foreground/80"
				>
					{REASON_LABELS[reason] ?? reason}
				</span>
			))}
		</span>
	)
}

export function FlagsPane({ all, stale }: FlagsPaneProps) {
	if (all.length === 0) return null
	return (
		<section className="mt-5 rounded-lg border border-border p-4">
			<div className="flex items-baseline gap-3">
				<h2 className="m-0 text-lg font-semibold">Flags</h2>
				<p className="m-0 text-[0.8rem] text-foreground/70">
					{all.length} declared · {stale.length} worth retiring
					{stale.length > 0 ? ' — `flags.remove` after ungating' : ''}
				</p>
			</div>
			<div className="mt-3 overflow-x-auto">
				<table className="w-full border-collapse text-sm">
					<thead>
						<tr className="text-left text-foreground/70">
							<th className="py-1 pr-4 font-medium">Flag</th>
							<th className="py-1 pr-4 font-medium">Gates</th>
							<th className="py-1 pr-4 font-medium">Age</th>
							<th className="py-1 pr-4 font-medium">Last evaluated</th>
							<th className="py-1 pr-4 font-medium">Evaluations</th>
							<th className="py-1 font-medium">Retire?</th>
						</tr>
					</thead>
					<tbody>
						{all.map((row) => (
							<tr key={row.key} className="border-t border-border align-top">
								<td className="py-1.5 pr-4">
									<span className="font-medium">{row.key}</span>
									<span className="block text-[0.75rem] text-foreground/60">
										{row.description}
									</span>
								</td>
								<td className="py-1.5 pr-4">{row.gates}</td>
								<td className="py-1.5 pr-4">{row.ageDays}d</td>
								<td className="py-1.5 pr-4">
									{row.lastEvaluatedAt
										? new Date(row.lastEvaluatedAt).toISOString().slice(0, 10)
										: 'never'}
								</td>
								<td className="py-1.5 pr-4">{row.evaluations}</td>
								<td className="py-1.5">
									<Reasons reasons={row.reasons} />
								</td>
							</tr>
						))}
					</tbody>
				</table>
			</div>
		</section>
	)
}
