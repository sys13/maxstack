/**
 * The modules pane — what is installed, at what version, what it
 * contributed, and what upgrades are available.
 *
 * The third surface of the picker, alongside the CLI (`maxstack add`) and MCP
 * (`browse_catalog`). All three render `describeCatalog()`, so a human browsing
 * the workbench and an agent calling the tool cannot be told different things —
 * which is the whole reason the derivation lives in one place.
 *
 * The pane answers the question the workbench is for: *what is this app made
 * of, and what has moved since I installed it.* An available upgrade is shown
 * with the codemods' own descriptions rather than a version number alone,
 * because "0.1.0 → 0.2.0" tells nobody whether they should care.
 */

import type { BundleSummary } from '@maxstack/features/bundle'

export interface ModulesPaneProps {
	modules: BundleSummary[]
}

function Chip({ children }: { children: React.ReactNode }) {
	return (
		<span className="rounded-full border border-border px-2 py-0.5 text-[0.7rem] text-foreground/80">
			{children}
		</span>
	)
}

export function ModulesPane({ modules }: ModulesPaneProps) {
	const installed = modules.filter((m) => m.installed)
	const upgradable = installed.filter((m) => m.installed?.upgradeTo)
	const available = modules.filter((m) => !m.installed)

	return (
		<section className="mt-5 rounded-lg border border-border p-4">
			<div className="flex items-baseline gap-3">
				<h2 className="m-0 text-lg font-semibold">Modules</h2>
				<p className="m-0 text-[0.8rem] text-foreground/70">
					{installed.length} installed · {available.length} available
					{upgradable.length > 0
						? ` · ${upgradable.length} with an upgrade — \`maxstack gen --upgrade\``
						: ''}
				</p>
			</div>

			{installed.length > 0 ? (
				<div className="mt-3 overflow-x-auto">
					<table className="w-full border-collapse text-sm">
						<thead>
							<tr className="text-left text-foreground/70">
								<th className="py-1 pr-4 font-medium">Module</th>
								<th className="py-1 pr-4 font-medium">Version</th>
								<th className="py-1 pr-4 font-medium">Contributed</th>
								<th className="py-1 font-medium">Upgrade</th>
							</tr>
						</thead>
						<tbody>
							{installed.map((module) => (
								<tr key={module.slug} className="border-t border-border/60">
									<td className="py-2 pr-4 align-top">
										<span className="font-mono text-[0.8rem]">
											{module.slug}
										</span>
										<div className="text-[0.75rem] text-foreground/60">
											{module.title}
										</div>
									</td>
									<td className="py-2 pr-4 align-top font-mono text-[0.8rem]">
										{module.installed?.version}
									</td>
									<td className="py-2 pr-4 align-top">
										<span className="flex flex-wrap gap-1">
											{module.contributes.length === 0 ? (
												<span className="text-foreground/50">—</span>
											) : (
												module.contributes.map((item, i) => (
													// biome-ignore lint/suspicious/noArrayIndexKey: the value alone is not unique and there is no id on this row; the list is loader-rendered and never reordered client-side, so value:index is stable
													<Chip key={`${item}:${i}`}>{item}</Chip>
												))
											)}
										</span>
									</td>
									<td className="py-2 align-top">
										{module.installed?.upgradeTo ? (
											<div>
												<span className="font-mono text-[0.8rem]">
													→ {module.installed.upgradeTo}
												</span>
												<ul className="mt-1 list-none p-0 text-[0.75rem] text-foreground/70">
													{module.installed.upgradeSteps?.map((step, i) => (
														// biome-ignore lint/suspicious/noArrayIndexKey: the value alone is not unique and there is no id on this row; the list is loader-rendered and never reordered client-side, so value:index is stable
														<li key={`${step}:${i}`}>{step}</li>
													))}
												</ul>
											</div>
										) : (
											<span className="text-foreground/50">current</span>
										)}
									</td>
								</tr>
							))}
						</tbody>
					</table>
				</div>
			) : (
				<p className="mt-3 text-[0.8rem] text-foreground/70">
					No modules installed. `maxstack add` lists the catalog; `maxstack add
					&lt;slug&gt; --dry-run` shows the spec diff before anything is
					written.
				</p>
			)}

			{available.length > 0 ? (
				<details className="mt-4">
					<summary className="cursor-pointer text-[0.8rem] text-foreground/70">
						{available.length} more available
					</summary>
					<ul className="mt-2 list-none p-0 text-sm">
						{available.map((module) => (
							<li key={module.slug} className="border-t border-border/60 py-2">
								<span className="font-mono text-[0.8rem]">{module.slug}</span>{' '}
								<span className="text-foreground/70">{module.title}</span>
								{module.requires.length > 0 ? (
									<span className="ml-2 text-[0.75rem] text-foreground/60">
										needs {module.requires.join(' + ')}
									</span>
								) : null}
								<div className="text-[0.75rem] text-foreground/60">
									{module.description.split('. ')[0]}.
								</div>
							</li>
						))}
					</ul>
				</details>
			) : null}
		</section>
	)
}
