/**
 * `<History>` — a per-record activity feed over the `audit` feature (Plan v5
 * task 35). Every privileged mutation the server records (create/update/delete,
 * see `operations.ts`'s audit sink) becomes one entry: who, what, when.
 *
 * Presentation-pure, like `<ResourceList>`/`<Show>`: the entries are a prop. A
 * route loads a record's audit feed (`auditReader.query({ resource, resourceId })`)
 * and hands it here — the component never fetches. `formatActor` maps a raw user
 * id to a display name; `formatTimestamp` renders the ISO time however the app
 * prefers.
 */

import type { ReactNode } from 'react'
import { Timestamp } from '../format/timestamp.tsx'
import { cn } from '../lib/cn.ts'

/** One audit entry — structurally `@maxstack/features`'s `StoredAuditEntry`, so
 * a loader hands the reader's output straight through (the UI stays core/features
 * free). */
export interface HistoryEntry {
	userId: string
	action: string
	resourceId?: string
	metadata?: Record<string, unknown>
	/** How the actor reached the app. Absent on entries written
	 * before the `audit` bundle's 0.2.0 upgrade, which read as "unknown" rather
	 * than being assumed human. */
	origin?: string
	/** The api key that made the change, when `origin` is `api-key`. */
	apiKeyId?: string
	/** ISO-8601 timestamp. */
	createdAt: string
}

export interface HistoryProps {
	/** The record's audit feed, most-recent first (as the reader returns it). */
	entries: HistoryEntry[]
	/** Heading above the feed; omit for none. */
	title?: ReactNode
	/** Rendered when there are no entries. */
	emptyState?: ReactNode
	/** Map a raw user id to a display name (default: the id verbatim). */
	formatActor?: (userId: string) => string
	/**
	 * Render the ISO timestamp yourself.
	 *
	 * Omit it and the feed uses `<Timestamp>`, which server-renders a
	 * runtime-independent string and upgrades to the viewer's locale after mount.
	 * The default used to be a bare `toLocaleString()`, which hydrates differently
	 * to how it server-renders on every viewer whose zone is not the server's
	 * — so supplying one here makes hydration YOUR problem.
	 */
	/**
	 * Render the ISO timestamp yourself.
	 *
	 * Omit it and the feed uses `<Timestamp>`, which server-renders a
	 * runtime-independent string and upgrades to the viewer's locale after mount
	 *. Supplying one makes hydration your problem.
	 */
	formatTimestamp?: (iso: string) => string
	className?: string
}

/** Past-tense verb + dot color per known action; unknown actions fall through to
 * the raw action string. */
const ACTION_VERB: Record<string, string> = {
	create: 'created',
	update: 'updated',
	delete: 'deleted',
}
/**
 * `update` takes the brand colour rather than a blue. The theme has no blue and
 * should not grow one for this: these three dots need to be *distinguishable*,
 * not to mean green/blue/red specifically, and success/primary/destructive are
 * three tokens that stay distinguishable in every preset — which `bg-blue-500`
 * did not, being the one dot that ignored the theme entirely.
 */
const ACTION_DOT: Record<string, string> = {
	create: 'bg-success',
	update: 'bg-primary',
	delete: 'bg-destructive',
}

/**
 * How the change was made, when it was not a person in this UI.
 *
 * A `session` entry is deliberately unlabelled — it is the overwhelming
 * majority, and a badge on every row is a badge nobody reads. The whole value
 * of this is that the *unusual* origins stand out: a row changed by a script or
 * an agent should be visibly different from one a colleague edited.
 */
const ORIGIN_LABEL: Record<string, string> = {
	'api-key': 'via API key',
	mcp: 'via agent (MCP)',
	system: 'automated',
}

/** For an update, the changed field list travels in `metadata.fields`; surface it
 * as a readable suffix ("updated name, priority"). */
function changedFields(metadata: HistoryEntry['metadata']): string {
	const fields = metadata?.fields
	if (Array.isArray(fields) && fields.length > 0) {
		return ` ${fields.map(String).join(', ')}`
	}
	return ''
}

export function History({
	entries,
	title = 'History',
	emptyState,
	formatActor = (id) => id,
	formatTimestamp,
	className,
}: HistoryProps): ReactNode {
	if (entries.length === 0) {
		return (
			<div className={className}>
				{title ? <h2 className="mb-2 text-sm font-semibold">{title}</h2> : null}
				{emptyState ?? (
					<p className="text-sm text-muted-foreground">No activity yet.</p>
				)}
			</div>
		)
	}

	return (
		<div className={className}>
			{title ? <h2 className="mb-2 text-sm font-semibold">{title}</h2> : null}
			<ol className="m-0 list-none space-y-3 p-0">
				{entries.map((entry, i) => {
					const verb = ACTION_VERB[entry.action] ?? entry.action
					const suffix =
						entry.action === 'update' ? changedFields(entry.metadata) : ''
					return (
						<li
							// biome-ignore lint/suspicious/noArrayIndexKey: an append-only feed has no stable per-entry id; position is stable enough for a static render.
							key={i}
							className="flex items-start gap-3 text-sm"
						>
							<span
								aria-hidden
								className={cn(
									'mt-1.5 size-2 shrink-0 rounded-full',
									ACTION_DOT[entry.action] ?? 'bg-muted-foreground',
								)}
							/>
							<div className="min-w-0">
								<span>
									<span className="font-medium">
										{formatActor(entry.userId)}
									</span>{' '}
									{verb}
									{suffix ? (
										<span className="text-muted-foreground">{suffix}</span>
									) : null}
									{entry.origin && ORIGIN_LABEL[entry.origin] ? (
										<span
											className="ml-2 rounded bg-muted px-1.5 py-0.5 text-xs text-muted-foreground"
											title={
												entry.apiKeyId ? `Key ${entry.apiKeyId}` : undefined
											}
										>
											{ORIGIN_LABEL[entry.origin]}
										</span>
									) : null}
								</span>
								<div className="text-xs text-muted-foreground">
									<time dateTime={entry.createdAt}>
										{formatTimestamp ? (
											formatTimestamp(entry.createdAt)
										) : (
											<Timestamp iso={entry.createdAt} />
										)}
									</time>
								</div>
							</div>
						</li>
					)
				})}
			</ol>
		</div>
	)
}
