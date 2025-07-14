import maxstack from 'maxstack'
import z from 'zod/v4'
import Template from './template'

export const variants = ['default', '1'] as const

export const LandingSchema = z.object({
	title: z.string(),
	description: z.string(),
	image: z.string().optional(),
	cta: z
		.object({
			text: z.string(),
			href: z.string(),
		})
		.optional(),
	variant: z.enum(variants).default('default').optional(),
})

export type LandingProps = z.infer<typeof LandingSchema>

export default function Landing({ variant, ...props }: LandingProps) {
	const { title, description, image, cta } = props
	switch (variant) {
		case '1':
			return <Landing2 {...props} />
		default:
			return (
				<div className="landing">
					<h1>{title}</h1>
					<p>{description}</p>
					{image && <img src={image} alt={title} />}
					{cta && (
						<a href={cta.href} className="cta-button">
							{cta.text}
						</a>
					)}
					<div className="space-y-8">
						<Template componentName="newsletterSignup" props={{}} />
						<Template
							componentName="faq"
							props={{
								faqs: [],
							}}
						/>
					</div>
				</div>
			)
	}
}

function Landing2({ title, description, image, cta }: LandingProps) {
	return (
		<div className="landing-variant-2">
			<h1>{title || `Welcome to ${maxstack.name}`}</h1>
			<p>{description || maxstack.description}</p>
			{image ? (
				<img src={image} alt={title ?? 'MAXSTACK'} />
			) : (
				<img src="/images/placeholder.svg" alt="Main" />
			)}
			{cta ? (
				<a href={cta.href} className="cta-button">
					{cta.text}
				</a>
			) : (
				<a href="/signup" className="cta-button">
					Get Started
				</a>
			)}
		</div>
	)
}

export const metaDescription = maxstack.description
