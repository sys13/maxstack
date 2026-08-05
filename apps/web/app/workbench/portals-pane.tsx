/**
 * The portals pane — every field every declared portal exposes, to
 * whom, and whether the surface is currently answering.
 *
 * This is the human-review half of the issue's gating bullet: *"a validate-time
 * report listing every publicly-reachable field, so exposure is reviewable as
 * data — and a workbench view of the same, since this is exactly the kind of
 * change a human must approve."*
 *
 * It renders `portalExposureReport` and nothing else, so there is **one source
 * of truth** for what is exposed: the CLI's table, this pane and the MCP tool are
 * three renderings of one fold over the declarations. A pane that assembled its
 * own view would be a second answer to the only question that matters here, and
 * the second answer is the one that is wrong.
 *
 * A paused portal is shown rather than hidden. It is one op from answering
 * again, so a report that dropped it would be answering "what is exposed today"
 * when the question is "what could be".
 */

import type { ExposedField } from '@maxstack/spec'

export interface PortalRow {
	key: string
	description: string
	audience: string
	scope: string
	entity: string
	paused: boolean
	fields: ExposedField[]
}

export interface PortalsPaneProps {
	portals: PortalRow[]
	summary: string
}

const ACCESS_LABEL: Record<string, string> = {
	read: 'read',
	create: 'create',
	update: 'update',
}

/** Unauthenticated audiences get the loud treatment; a role portal does not. */
function AudienceBadge({ audience }: { audience: string }) {
	const loud = audience === 'public'
	return (
		<span
			className={
				loud
					? 'rounded-full border border-destructive px-2 py-0.5 text-[0.7rem] font-medium uppercase text-destructive'
					: 'rounded-full border border-border px-2 py-0.5 text-[0.7rem] uppercase text-foreground/80'
			}
		>
			{audience}
		</span>
	)
}

export function PortalsPane({ portals, summary }: PortalsPaneProps) {
	if (portals.length === 0) return null
	return (
		<section className="mt-5 rounded-lg border border-border p-4">
			<div className="flex items-baseline gap-3">
				<h2 className="m-0 text-lg font-semibold">Public surfaces</h2>
				<p className="m-0 text-[0.8rem] text-foreground/70">{summary}</p>
			</div>
			<p className="mt-1 text-[0.75rem] text-foreground/60">
				Exactly what somebody outside this app can reach. Widen it with{' '}
				<code>portals.setFields</code>, open a write path with{' '}
				<code>portals.setWrites</code>, and take a surface offline with{' '}
				<code>portals.pause</code> — which loses nothing.
			</p>
			{portals.map((portal) => (
				<div key={portal.key} className="mt-4">
					<div className="flex flex-wrap items-baseline gap-2">
						<span className="font-medium">/p/{portal.key}</span>
						<AudienceBadge audience={portal.audience} />
						<span className="text-[0.75rem] text-foreground/60">
							{portal.scope} over {portal.entity}
						</span>
						{portal.paused ? (
							<span className="rounded-full border border-border px-2 py-0.5 text-[0.7rem] text-foreground/60">
								paused
							</span>
						) : null}
					</div>
					<p className="m-0 text-[0.75rem] text-foreground/60">
						{portal.description}
					</p>
					<div className="mt-2 overflow-x-auto">
						<table className="w-full border-collapse text-sm">
							<thead>
								<tr className="text-left text-foreground/70">
									<th className="py-1 pr-4 font-medium">Access</th>
									<th className="py-1 font-medium">Field</th>
								</tr>
							</thead>
							<tbody>
								{portal.fields.map((field) => (
									<tr
										key={`${field.access}:${field.fieldId}`}
										className="border-t border-border"
									>
										<td className="py-1 pr-4">
											{ACCESS_LABEL[field.access] ?? field.access}
										</td>
										<td className="py-1">{field.fieldId}</td>
									</tr>
								))}
							</tbody>
						</table>
					</div>
				</div>
			))}
		</section>
	)
}
