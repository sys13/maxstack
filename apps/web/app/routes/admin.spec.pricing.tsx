import { getPlatform } from '~/sprout.server'
import type { Route } from './+types/admin.spec.pricing'

export async function loader() {
	const spec = await getPlatform().spec.load()
	const tiers = spec.pricing.tiers.map((t) => ({
		id: t.id,
		name: t.name,
		priceMonthly: t.priceMonthly,
		features: t.features,
	}))
	return { tiers, model: spec.product?.businessModel ?? null }
}

export default function SpecPricing({ loaderData }: Route.ComponentProps) {
	const { tiers, model } = loaderData
	return (
		<section>
			<h1 className="mb-2 text-2xl font-semibold">Pricing</h1>
			<p className="mb-6 max-w-prose text-sm text-muted-foreground">
				The spec's pricing/business-model layer.
				{model ? ` Business model: ${model.type}.` : ''}
			</p>
			{tiers.length === 0 ? (
				<p className="text-sm text-muted-foreground">
					No pricing tiers in the spec yet.
				</p>
			) : (
				<div className="grid gap-4 [grid-template-columns:repeat(auto-fill,minmax(14rem,1fr))]">
					{tiers.map((t) => (
						<div key={t.id} className="rounded-lg border border-border p-4">
							<div className="font-semibold">{t.name}</div>
							<div className="mt-1 text-2xl font-semibold">
								${t.priceMonthly}
								<span className="text-sm font-normal text-muted-foreground">
									/mo
								</span>
							</div>
							{t.features.length > 0 ? (
								<ul className="mt-3 list-disc space-y-0.5 pl-5 text-sm text-muted-foreground">
									{t.features.map((f) => (
										<li key={f}>{f}</li>
									))}
								</ul>
							) : null}
						</div>
					))}
				</div>
			)}
		</section>
	)
}
