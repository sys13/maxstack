/**
 * `/metrics` — the admin metrics dashboard (the `admin` bundle's surface). Runs
 * the db-agnostic aggregations from `@maxstack/features/metrics` over the auth
 * `user`/`session` tables (always present — auth is materialized at boot) and the
 * `audit_log` table (present only when the `audit` bundle is installed). Audit-
 * dependent numbers degrade gracefully when that table is absent.
 *
 * Deferred: a charts/trends visual — this renders
 * the numbers as plain stat cards + a day-by-day registrations table.
 */

import {
	getSystemMetrics,
	getUserMetrics,
	getUserRegistrationTrends,
	type MetricsDb,
} from '@maxstack/features/metrics'
import { getSprout } from '~/sprout.server'
import type { Route } from './+types/metrics'

export async function loader() {
	const { backend } = await getSprout()
	const client = backend.client
	if (!client) {
		// Postgres backend: the pglite `query` adapter isn't wired here yet.
		return { available: false as const }
	}
	const db: MetricsDb = { query: (sql) => client.query(sql) }

	const users = await getUserMetrics(db)
	const trends = await getUserRegistrationTrends(db)
	// Audit-dependent numbers: null when the `audit` bundle isn't installed.
	let system: Awaited<ReturnType<typeof getSystemMetrics>> | null = null
	try {
		system = await getSystemMetrics(db)
	} catch {
		system = null
	}
	return { available: true as const, users, trends, system }
}

export default function Metrics({ loaderData }: Route.ComponentProps) {
	if (!loaderData.available) {
		return (
			<section>
				<h1 className="mb-2 text-2xl font-semibold">Metrics</h1>
				<p className="text-sm text-muted-foreground">
					Metrics are available on the pglite backend.
				</p>
			</section>
		)
	}

	const { users, trends, system } = loaderData
	const stats: [string, number][] = [
		['Users', users.total],
		['New (7d)', users.newThisWeek],
		['New (30d)', users.newThisMonth],
		['Verified', users.verified],
		['Admins', users.admins],
		['Active today', users.activeToday],
		['Audit entries', system?.auditLogCount ?? 0],
		['Sessions', system?.sessionCount ?? 0],
	]

	return (
		<section className="p-6">
			<h1 className="mb-2 text-2xl font-semibold">Metrics</h1>
			<p className="mb-6 max-w-prose text-sm text-muted-foreground">
				Aggregations over the auth and audit tables (
				<code>@maxstack/features/metrics</code>).
			</p>
			<div className="mb-8 grid gap-4 [grid-template-columns:repeat(auto-fill,minmax(9rem,1fr))]">
				{stats.map(([label, value]) => (
					<div key={label} className="rounded-lg border border-border p-4">
						<div className="text-2xl font-semibold">{value}</div>
						<div className="text-sm text-muted-foreground">{label}</div>
					</div>
				))}
			</div>
			<h2 className="mb-2 text-lg font-semibold">Registrations by day</h2>
			{trends.length === 0 ? (
				<p className="text-sm text-muted-foreground">No registrations yet.</p>
			) : (
				<table className="text-sm">
					<thead>
						<tr>
							<th className="pr-8 text-left font-medium">Day</th>
							<th className="text-left font-medium">Count</th>
						</tr>
					</thead>
					<tbody>
						{trends.map((t) => (
							<tr key={t.day}>
								<td className="pr-8">{t.day}</td>
								<td>{t.count}</td>
							</tr>
						))}
					</tbody>
				</table>
			)}
		</section>
	)
}
