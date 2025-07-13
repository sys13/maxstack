import { useState } from "react";
import { useFetcher } from "react-router";
import z from "zod/v4";
import { Button } from "~/components/ui/button";
import {
	Card,
	CardContent,
	CardDescription,
	CardHeader,
	CardTitle,
} from "~/components/ui/card";
import { Input } from "~/components/ui/input";
import { Label } from "~/components/ui/label";

export const variants = ["default", "inline", "card"] as const;

export const NewsletterSignupSchema = z.object({
	title: z.string().default("Stay Updated").optional(),
	description: z
		.string()
		.default("Subscribe to our newsletter for the latest updates and tips.")
		.optional(),
	placeholder: z.string().default("Enter your email address").optional(),
	buttonText: z.string().default("Subscribe").optional(),
	successMessage: z.string().default("Thank you for subscribing!").optional(),
	errorMessage: z
		.string()
		.default("Please enter a valid email address.")
		.optional(),
	variant: z.enum(variants).default("default").optional(),
});

export type NewsletterSignupProps = z.infer<typeof NewsletterSignupSchema>;

export default function NewsletterSignup({
	title = "Stay Updated",
	description = "Subscribe to our newsletter for the latest updates and tips.",
	placeholder = "Enter your email address",
	buttonText = "Subscribe",
	successMessage = "Thank you for subscribing!",
	errorMessage = "Please enter a valid email address.",
	variant = "default",
}: NewsletterSignupProps) {
	const [email, setEmail] = useState("");
	const [status, setStatus] = useState<
		"idle" | "loading" | "success" | "error"
	>("idle");
	const [message, setMessage] = useState("");
	const fetcher = useFetcher();

	const handleSubmit = async (e: React.FormEvent) => {
		e.preventDefault();

		// Basic email validation
		const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
		if (!emailRegex.test(email)) {
			setStatus("error");
			setMessage(errorMessage);
			return;
		}

		setStatus("loading");

		try {
			await fetcher.submit(
				{ email },
				{ method: "post", action: "/newsletter" },
			);
			setStatus("success");
			setMessage(successMessage);
			setEmail("");
		} catch (_error) {
			setStatus("error");
			setMessage("Something went wrong. Please try again.");
		}
	};

	const renderForm = () => (
		<form onSubmit={handleSubmit} className="space-y-4">
			<div className="space-y-2">
				{variant !== "inline" && (
					<Label htmlFor="newsletter-email">Email</Label>
				)}
				<div className="flex gap-2">
					<Input
						id="newsletter-email"
						type="email"
						placeholder={placeholder}
						value={email}
						onChange={(e) => setEmail(e.target.value)}
						disabled={status === "loading"}
						required
						className="flex-1"
					/>
					{variant === "inline" && (
						<Button
							type="submit"
							disabled={status === "loading" || !email}
							className="shrink-0"
						>
							{status === "loading" ? "Subscribing..." : buttonText}
						</Button>
					)}
				</div>
				{variant !== "inline" && (
					<Button
						type="submit"
						disabled={status === "loading" || !email}
						className="w-full"
					>
						{status === "loading" ? "Subscribing..." : buttonText}
					</Button>
				)}
			</div>

			{message && (
				<div
					className={`text-sm ${
						status === "success" ? "text-green-600" : "text-red-600"
					}`}
				>
					{message}
				</div>
			)}
		</form>
	);

	switch (variant) {
		case "card":
			return (
				<Card className="w-full max-w-md mx-auto">
					<CardHeader>
						<CardTitle>{title}</CardTitle>
						<CardDescription>{description}</CardDescription>
					</CardHeader>
					<CardContent>{renderForm()}</CardContent>
				</Card>
			);

		case "inline":
			return (
				<div className="newsletter-signup-inline">
					<div className="space-y-2 mb-4">
						<h3 className="text-lg font-semibold">{title}</h3>
						<p className="text-sm text-muted-foreground">{description}</p>
					</div>
					{renderForm()}
				</div>
			);

		default:
			return (
				<div className="newsletter-signup">
					<div className="space-y-4">
						<div className="text-center space-y-2">
							<h2 className="text-2xl font-bold">{title}</h2>
							<p className="text-muted-foreground">{description}</p>
						</div>
						{renderForm()}
					</div>
				</div>
			);
	}
}
