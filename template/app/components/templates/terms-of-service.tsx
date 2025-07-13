import { z } from "zod";

export const TermsOfServiceSchema = z.object({
	textParagraphs: z.array(z.string()),
});

export type TermsOfServiceProps = z.infer<typeof TermsOfServiceSchema>;

export function TermsOfService({ textParagraphs }: TermsOfServiceProps) {
	return (
		<section className="bg-white dark:bg-zinc-900 rounded-xl shadow-lg p-8 border border-zinc-200 dark:border-zinc-800">
			<h1 className="text-3xl font-bold mb-6 text-zinc-900 dark:text-zinc-100 text-center">
				Terms of Service
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
	);
}

export default TermsOfService;
