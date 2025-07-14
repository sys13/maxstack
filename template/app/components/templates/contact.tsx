import z from 'zod/v4'

export const variants = ['default'] as const

export const ContactSchema = z.object({
	title: z.string().default('Contact Us'),
	description: z.string().default('Get in touch with our team'),
	email: z.string().optional(),
	phone: z.string().optional(),
	address: z.string().optional(),
	socialLinks: z
		.array(
			z.object({
				platform: z.string(),
				url: z.string(),
				label: z.string(),
			}),
		)
		.optional(),
	variant: z.enum(variants).default('default').optional(),
})

export type ContactProps = z.infer<typeof ContactSchema>

export default function Contact({
	title,
	description,
	email,
	phone,
	address,
	socialLinks = [],
}: ContactProps) {
	return (
		<div className="contact">
			<header className="contact-header">
				<h1>{title}</h1>
				<p>{description}</p>
			</header>

			<div className="contact-content">
				<div className="contact-info">
					{email && (
						<div className="contact-item">
							<h3>Email</h3>
							<a href={`mailto:${email}`}>{email}</a>
						</div>
					)}

					{phone && (
						<div className="contact-item">
							<h3>Phone</h3>
							<a href={`tel:${phone}`}>{phone}</a>
						</div>
					)}

					{address && (
						<div className="contact-item">
							<h3>Address</h3>
							<p>{address}</p>
						</div>
					)}

					{socialLinks.length > 0 && (
						<div className="contact-item">
							<h3>Follow Us</h3>
							<div className="social-links">
								{socialLinks.map((link) => (
									<a
										key={link.label + link.url}
										href={link.url}
										target="_blank"
										rel="noopener noreferrer"
									>
										{link.label}
									</a>
								))}
							</div>
						</div>
					)}
				</div>

				<div className="contact-form">
					<h3>Send us a message</h3>
					<form>
						<div className="form-group">
							<label htmlFor="name">Name</label>
							<input type="text" id="name" name="name" required />
						</div>
						<div className="form-group">
							<label htmlFor="email">Email</label>
							<input type="email" id="email" name="email" required />
						</div>
						<div className="form-group">
							<label htmlFor="message">Message</label>
							<textarea
								id="message"
								name="message"
								rows={5}
								required
							></textarea>
						</div>
						<button type="submit">Send Message</button>
					</form>
				</div>
			</div>
		</div>
	)
}
