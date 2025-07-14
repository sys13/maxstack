import {
	Accordion,
	AccordionContent,
	AccordionItem,
	AccordionTrigger,
} from '@/components/ui/accordion'
import * as z from 'zod'

export const FaqSchema = z.object({
	title: z.string().default('Frequently Asked Questions').optional(),
	faqs: z
		.array(
			z.object({
				question: z.string(),
				answer: z.string(),
			}),
		)
		.default([]),
})

export type FaqProps = z.infer<typeof FaqSchema>

function Faq({ title, faqs }: FaqProps) {
	if (!faqs || faqs.length === 0) {
		return null
	}
	return (
		<section className="faq-section space-y-8">
			<h2 className="text-2xl font-bold mb-6 text-center">{title}</h2>
			<div>
				<Accordion type="single" collapsible>
					{faqs.map((faq, idx) => (
						<AccordionItem key={faq.question} value={`item-${idx + 1}`}>
							<AccordionTrigger>{faq.question}</AccordionTrigger>
							<AccordionContent>{faq.answer}</AccordionContent>
						</AccordionItem>
					))}
				</Accordion>
			</div>
		</section>
	)
}

export default Faq
