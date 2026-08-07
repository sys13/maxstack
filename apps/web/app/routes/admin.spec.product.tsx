import { PRD_SECTION_COUNT, unauthoredPrdSections } from '@maxstack/spec'
import type { ReactNode } from 'react'
import { getPlatform } from '~/sprout.server'
import type { Route } from './+types/admin.spec.product'

export async function loader() {
	const spec = await getPlatform().spec.load()
	// The PRD is a plain serializable object; hand it to the view whole and let
	// each section guard its own fields, so a partial/evolving brief still
	// renders whatever it does have.
	//
	// `unauthored` is computed here rather than eyeballed in the view (#343):
	// `maxstack init` writes a complete, fluent brief nobody wrote, and this pane
	// rendered it exactly like a real one. Which sections are still scaffold is a
	// fact about the doc, so it is derived once, from the same helper the CLI
	// gate and the MCP summary use, and shown at the top where it is read.
	return {
		product: spec.product,
		unauthored: unauthoredPrdSections(spec.product),
	}
}

/** A titled block that renders nothing when it has no children. */
function Section({ title, children }: { title: string; children: ReactNode }) {
	if (children === null || children === undefined || children === false) {
		return null
	}
	return (
		<section className="mt-8">
			<h2 className="mb-3 text-lg font-semibold">{title}</h2>
			{children}
		</section>
	)
}

function Field({ label, value }: { label: string; value?: ReactNode }) {
	if (value === null || value === undefined || value === '') return null
	return (
		<div className="mb-2">
			<span className="text-xs uppercase tracking-wider text-muted-foreground">
				{label}
			</span>
			<div className="text-sm">{value}</div>
		</div>
	)
}

function Bullets({ items }: { items?: readonly ReactNode[] }) {
	if (!items || items.length === 0) return null
	return (
		<ul className="list-disc space-y-1 pl-5 text-sm text-muted-foreground">
			{items.map((it, i) => (
				// biome-ignore lint/suspicious/noArrayIndexKey: read-only static list
				<li key={i}>{it}</li>
			))}
		</ul>
	)
}

function Card({ children }: { children: ReactNode }) {
	return <div className="rounded-lg border border-border p-4">{children}</div>
}

export default function SpecProduct({ loaderData }: Route.ComponentProps) {
	const p = loaderData.product
	if (!p) {
		return (
			<section>
				<h1 className="text-2xl font-semibold">Product</h1>
				<p className="mt-2 text-sm text-muted-foreground">
					No product brief in the spec yet.
				</p>
			</section>
		)
	}
	const scope = p.scope
	const unauthored = loaderData.unauthored ?? []
	return (
		<section className="max-w-4xl">
			<div className="flex flex-wrap items-baseline gap-3">
				<h1 className="text-2xl font-semibold">{p.meta?.title ?? 'Product'}</h1>
				{p.meta?.status ? (
					<span className="rounded-full border border-border px-2 py-0.5 text-xs text-muted-foreground">
						{p.meta.status}
					</span>
				) : null}
			</div>
			<div className="mt-1 text-sm text-muted-foreground">
				{[
					p.meta?.version && `v${p.meta.version}`,
					p.meta?.author,
					p.meta?.lastUpdated,
				]
					.filter(Boolean)
					.join(' · ')}
			</div>

			{unauthored.length > 0 ? (
				<div className="mt-4 rounded-lg border border-amber-500/40 bg-amber-500/10 p-4 text-sm">
					<div className="font-semibold">
						{unauthored.length} of {PRD_SECTION_COUNT} sections have never been
						authored
					</div>
					<p className="mt-1 text-muted-foreground">
						They are still the <code>maxstack init</code> skeleton. What you
						read below in these sections was scaffolded, not decided — treat it
						as blank:
					</p>
					<ul className="mt-2 list-disc space-y-1 pl-5 text-muted-foreground">
						{unauthored.map((gap) => (
							<li key={gap.path}>
								<code>{gap.path}</code> — {gap.hint}
							</li>
						))}
					</ul>
				</div>
			) : null}

			<Section title="Context">
				{p.context ? (
					<>
						<Field label="TL;DR" value={p.context.tldr} />
						<Field label="Background" value={p.context.background} />
					</>
				) : null}
			</Section>

			<Section title="Problem">
				{p.problem ? (
					<>
						<Field label="Statement" value={p.problem.statement} />
						<Field label="Cost of inaction" value={p.problem.costOfInaction} />
						<Field label="Type" value={p.problem.painkillerOrVitamin} />
					</>
				) : null}
			</Section>

			<Section title="Audience">
				{p.audience?.personas?.length ? (
					<div className="grid gap-3 sm:grid-cols-2">
						{p.audience.personas.map((persona) => (
							<Card key={persona.name}>
								<div className="font-semibold">{persona.name}</div>
								<div className="mt-1 text-sm text-muted-foreground">
									{persona.description}
								</div>
								<div className="mt-2">
									<Bullets items={persona.goals} />
								</div>
							</Card>
						))}
					</div>
				) : null}
			</Section>

			<Section title="Goals & metrics">
				{p.goals ? (
					<>
						{p.goals.northStarMetric ? (
							<Field
								label="North-star metric"
								value={`${p.goals.northStarMetric.name} — ${p.goals.northStarMetric.definition}`}
							/>
						) : null}
						{p.goals.businessGoals?.length ? (
							<div className="mt-2">
								<div className="mb-1 text-xs uppercase tracking-wider text-muted-foreground">
									Business goals
								</div>
								<Bullets
									items={p.goals.businessGoals.map((g) => g.statement)}
								/>
							</div>
						) : null}
						{p.goals.userGoals?.length ? (
							<div className="mt-2">
								<div className="mb-1 text-xs uppercase tracking-wider text-muted-foreground">
									User goals
								</div>
								<Bullets items={p.goals.userGoals.map((g) => g.statement)} />
							</div>
						) : null}
					</>
				) : null}
			</Section>

			<Section title="Scope">
				{scope ? (
					<div className="grid gap-4 sm:grid-cols-2">
						{(
							[
								['Must have', scope.mustHave],
								['Should have', scope.shouldHave],
								['Could have', scope.couldHave],
								["Won't have", scope.wontHave],
							] as const
						).map(([label, items]) =>
							items?.length ? (
								<div key={label}>
									<div className="mb-1 text-xs uppercase tracking-wider text-muted-foreground">
										{label}
									</div>
									<Bullets items={items.map((s) => s.description)} />
								</div>
							) : null,
						)}
						{scope.nonGoals?.length ? (
							<div>
								<div className="mb-1 text-xs uppercase tracking-wider text-muted-foreground">
									Non-goals
								</div>
								<Bullets items={scope.nonGoals} />
							</div>
						) : null}
					</div>
				) : null}
			</Section>

			<Section title={`Requirements (${p.requirements?.length ?? 0})`}>
				{p.requirements?.length ? (
					<div className="space-y-3">
						{p.requirements.map((r) => (
							<Card key={r.id}>
								<div className="flex items-baseline justify-between gap-2">
									<span className="text-sm font-medium">{r.userStory}</span>
									<span className="rounded border border-border px-1.5 py-0.5 text-xs text-muted-foreground">
										{r.priority}
									</span>
								</div>
								<div className="mt-2">
									<Bullets items={r.acceptanceCriteria} />
								</div>
							</Card>
						))}
					</div>
				) : null}
			</Section>

			<Section title="Roadmap">
				{p.roadmap?.phases?.length ? (
					<div className="space-y-3">
						{p.roadmap.phases.map((phase) => (
							<Card key={phase.id}>
								<div className="font-semibold">{phase.name}</div>
								<div className="mt-1 text-sm text-muted-foreground">
									{phase.goal}
								</div>
							</Card>
						))}
					</div>
				) : null}
			</Section>

			<Section title="Open questions">
				{p.openQuestions?.length ? (
					<Bullets items={p.openQuestions.map((q) => q.question)} />
				) : null}
			</Section>
		</section>
	)
}
