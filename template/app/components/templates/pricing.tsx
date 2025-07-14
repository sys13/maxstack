import z from 'zod/v4'

export const variants = ['default'] as const

export const PricingSchema = z.object({
	title: z.string().default('Pricing Plans').optional(),
	description: z
		.string()
		.default('Choose the plan that fits your needs')
		.optional(),
	plans: z.array(
		z.object({
			name: z.string(),
			price: z.string(),
			interval: z.string().optional(),
			features: z.array(z.string()),
			featured: z.boolean().optional(),
			cta: z
				.object({
					text: z.string(),
					href: z.string(),
				})
				.optional(),
		}),
	),
	children: z.any().optional(),
	variant: z.enum(variants).default('default').optional(),
})

export type PricingProps = z.infer<typeof PricingSchema>

export default function Pricing({
	title,
	description,
	plans,
	children,
}: PricingProps) {
	return (
		<div className="pricing max-w-7xl mx-auto px-4 py-16">
			<div className="text-center mb-16">
				<h1 className="text-4xl font-bold text-gray-900 dark:text-white mb-4">
					{title}
				</h1>
				<p className="text-xl text-gray-600 dark:text-gray-300 max-w-2xl mx-auto">
					{description}
				</p>
			</div>
			<div className="pricing-plans grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-8">
				{plans.map((plan) => (
					<div
						key={plan.name}
						className={`pricing-plan relative bg-white dark:bg-gray-800 rounded-lg shadow-lg border p-8 transition-transform hover:scale-105 ${
							plan.featured
								? 'featured border-blue-500 ring-2 ring-blue-500 ring-opacity-50'
								: 'border-gray-200 dark:border-gray-700'
						}`}
					>
						{plan.featured && (
							<div className="absolute top-0 left-1/2 transform -translate-x-1/2 -translate-y-1/2">
								<span className="bg-blue-500 text-white px-4 py-1 rounded-full text-sm font-semibold">
									Most Popular
								</span>
							</div>
						)}
						<h3 className="text-2xl font-bold text-gray-900 dark:text-white mb-4">
							{plan.name}
						</h3>
						<div className="price mb-6">
							<span className="amount text-4xl font-bold text-gray-900 dark:text-white">
								{plan.price}
							</span>
							{plan.interval && (
								<span className="interval text-gray-500 dark:text-gray-400 ml-1">
									/{plan.interval}
								</span>
							)}
						</div>
						<ul className="features space-y-3 mb-8">
							{plan.features.map((feature) => (
								<li
									key={feature}
									className="flex items-center text-gray-600 dark:text-gray-300"
								>
									<svg
										className="w-5 h-5 text-green-500 mr-3 flex-shrink-0"
										fill="none"
										stroke="currentColor"
										viewBox="0 0 24 24"
									>
										<path
											strokeLinecap="round"
											strokeLinejoin="round"
											strokeWidth={2}
											d="M5 13l4 4L19 7"
										/>
									</svg>
									{feature}
								</li>
							))}
						</ul>
						{plan.cta && (
							<a
								href={plan.cta.href}
								className={`cta-button block w-full text-center py-3 px-6 rounded-lg font-semibold transition-colors ${
									plan.featured
										? 'bg-blue-500 text-white hover:bg-blue-600'
										: 'bg-gray-100 dark:bg-gray-700 text-gray-900 dark:text-white hover:bg-gray-200 dark:hover:bg-gray-600'
								}`}
							>
								{plan.cta.text}
							</a>
						)}
					</div>
				))}
			</div>
			{children}
		</div>
	)
}
