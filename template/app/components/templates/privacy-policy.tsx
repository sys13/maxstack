import { z } from 'zod'

export const PrivacyPolicySchema = z.object({
	textParagraphs: z.array(z.string()),
})

export type PrivacyPolicyProps = z.infer<typeof PrivacyPolicySchema>

export function PrivacyPolicy({ textParagraphs }: PrivacyPolicyProps) {
	return (
		<section className="bg-white dark:bg-zinc-900 rounded-xl shadow-lg p-8 border border-zinc-200 dark:border-zinc-800">
			<h1 className="text-3xl font-bold mb-6 text-zinc-900 dark:text-zinc-100 text-center">
				Privacy Policy
			</h1>
			<div className="space-y-5">
				{textParagraphs.map((paragraph) => (
					<p
						key={paragraph.slice(0, 24)}
						className="text-zinc-700 dark:text-zinc-300 leading-relaxed text-lg"
					>
						{paragraph}
					</p>
				))}
			</div>
		</section>
	)
}

export default PrivacyPolicy
