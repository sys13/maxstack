import z from "zod/v4";

export const variants = ["default"] as const;

export const AboutSchema = z.object({
	title: z.string().default("About Us"),
	description: z.string().default("Learn more about our mission and team"),
	mission: z.string().optional(),
	team: z
		.array(
			z.object({
				name: z.string(),
				role: z.string(),
				bio: z.string().optional(),
				avatar: z.string().optional(),
			}),
		)
		.optional(),
	testimonials: z
		.array(
			z.object({
				quote: z.string(),
				author: z.string(),
				company: z.string().optional(),
				avatar: z.string().optional(),
			}),
		)
		.optional(),
	variant: z.enum(variants).default("default").optional(),
});

export type AboutProps = z.infer<typeof AboutSchema>;

export default function About({
	title,
	description,
	mission,
	team = [],
	testimonials = [],
}: AboutProps) {
	return (
		<div className="about">
			<header className="about-header">
				<h1>{title}</h1>
				<p>{description}</p>
			</header>

			{mission && (
				<section className="mission">
					<h2>Our Mission</h2>
					<p>{mission}</p>
				</section>
			)}

			{team.length > 0 && (
				<section className="team">
					<h2>Meet the Team</h2>
					<div className="team-grid">
						{team.map((member) => (
							<div key={member.name + member.bio} className="team-member">
								{member.avatar && <img src={member.avatar} alt={member.name} />}
								<h3>{member.name}</h3>
								<p className="role">{member.role}</p>
								{member.bio && <p className="bio">{member.bio}</p>}
							</div>
						))}
					</div>
				</section>
			)}

			{testimonials.length > 0 && (
				<section className="testimonials">
					<h2>What People Say</h2>
					<div className="testimonials-grid">
						{testimonials.map((testimonial) => (
							<blockquote key={testimonial.quote} className="testimonial">
								<p>"{testimonial.quote}"</p>
								<cite>
									{testimonial.avatar && (
										<img src={testimonial.avatar} alt={testimonial.author} />
									)}
									<span className="author">{testimonial.author}</span>
									{testimonial.company && (
										<span className="company">{testimonial.company}</span>
									)}
								</cite>
							</blockquote>
						))}
					</div>
				</section>
			)}
		</div>
	);
}
