import z from "zod/v4";

export const variants = ["default"] as const;

export const FeaturesSchema = z.object({
	title: z.string().default("Features"),
	description: z
		.string()
		.default("Powerful features to help you manage tasks effectively"),
	features: z
		.array(
			z.object({
				name: z.string(),
				description: z.string(),
				icon: z.string().optional(),
				benefits: z.array(z.string()).optional(),
			}),
		)
		.optional(),
	variant: z.enum(variants).default("default").optional(),
});

export type FeaturesProps = z.infer<typeof FeaturesSchema>;

export default function Features({
	title,
	description,
	features = [],
}: FeaturesProps) {
	return (
		<div className="features max-w-7xl mx-auto px-4 py-16">
			<header className="features-header text-center mb-16">
				<h1 className="text-4xl font-bold text-gray-900 dark:text-white mb-4">
					{title}
				</h1>
				<p className="text-xl text-gray-600 dark:text-gray-300 max-w-3xl mx-auto">
					{description}
				</p>
			</header>

			<div className="features-grid grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-8">
				{features.map((feature) => (
					<div
						key={feature.name}
						className="feature-card bg-white dark:bg-gray-800 rounded-lg shadow-lg border border-gray-200 dark:border-gray-700 p-8 hover:shadow-xl transition-shadow"
					>
						{feature.icon && (
							<div className="feature-icon text-4xl mb-6 text-blue-500">
								{feature.icon}
							</div>
						)}
						<h3 className="text-2xl font-bold text-gray-900 dark:text-white mb-4">
							{feature.name}
						</h3>
						<p className="text-gray-600 dark:text-gray-300 mb-6 leading-relaxed">
							{feature.description}
						</p>
						{feature.benefits && feature.benefits.length > 0 && (
							<ul className="feature-benefits space-y-2">
								{feature.benefits.map((benefit) => (
									<li
										key={benefit}
										className="flex items-center text-sm text-gray-600 dark:text-gray-300"
									>
										<svg
											className="w-4 h-4 text-green-500 mr-2 flex-shrink-0"
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
										{benefit}
									</li>
								))}
							</ul>
						)}
					</div>
				))}
			</div>
		</div>
	);
}
