import type { ComponentProps } from "react";
import About, { AboutSchema } from "./about";
import BlogLanding, { BlogLandingSchema } from "./blog_landing";
import BlogPost, { BlogPostSchema } from "./blog_post";
import Contact, { ContactSchema } from "./contact";
import Faq, { FaqSchema } from "./faq";
import Features, { FeaturesSchema } from "./features";
import Landing, { LandingSchema, metaDescription } from "./landing";
import MarketingFooter, { MarketingFooterSchema } from "./marketing_footer";
import MarketingNav, { MarketingNavSchema } from "./marketing_nav";
import MaxStackWelcome, { MaxStackWelcomeSchema } from "./maxstack-welcome";
import NewsletterSignup, { NewsletterSignupSchema } from "./newsletter-signup";
import Pricing, { PricingSchema } from "./pricing";
import PrivacyPolicy, { PrivacyPolicySchema } from "./privacy-policy";
import TermsOfService, { TermsOfServiceSchema } from "./terms-of-service";

export const registry = {
	landing: {
		schema: LandingSchema,
		component: Landing,
		name: "landing",
		route: "/",
		metaDescription: "Welcome",
	},
	pricing: {
		schema: PricingSchema,
		component: Pricing,
		name: "pricing",
		route: "/pricing",
		metaDescription,
	},
	about: {
		schema: AboutSchema,
		component: About,
		name: "about",
		route: "/about",
		metaDescription: "Learn more about our company and mission",
	},
	features: {
		schema: FeaturesSchema,
		component: Features,
		name: "features",
		route: "/features",
		metaDescription: "Discover powerful features that help you manage tasks",
	},
	contact: {
		schema: ContactSchema,
		component: Contact,
		name: "contact",
		route: "/contact",
		metaDescription: "Get in touch with our team",
	},
	newsletterSignup: {
		schema: NewsletterSignupSchema,
		component: NewsletterSignup,
		name: "newsletterSignup",
		metaDescription: "Subscribe to our newsletter for updates",
	},
	blogLanding: {
		schema: BlogLandingSchema,
		component: BlogLanding,
		name: "blogLanding",
		route: "/blog",
		metaDescription: "Read our latest insights and updates",
	},
	blogPost: {
		schema: BlogPostSchema,
		component: BlogPost,
		name: "blogPost",
		route: "/blog/:slug",
		metaDescription: "Read our blog post",
	},
	termsOfService: {
		schema: TermsOfServiceSchema,
		component: TermsOfService,
		name: "termsOfService",
		route: "/terms-of-service",
		metaDescription: "Read our terms of service",
	},
	privacyPolicy: {
		schema: PrivacyPolicySchema,
		component: PrivacyPolicy,
		name: "privacyPolicy",
		route: "/privacy-policy",
		metaDescription: "Read our privacy policy",
	},
	marketingFooter: {
		schema: MarketingFooterSchema,
		component: MarketingFooter,
		name: "marketingFooter",
	},
	marketingNav: {
		schema: MarketingNavSchema,
		component: MarketingNav,
		name: "marketingNav",
	},
	faq: {
		schema: FaqSchema,
		component: Faq,
		name: "faq",
		metaDescription: "Frequently Asked Questions",
	},
	maxstackWelcome: {
		schema: MaxStackWelcomeSchema,
		component: MaxStackWelcome,
		name: "maxstackWelcome",
	},
} as const;

export const registryValues = Object.values(registry);

type RegistryKey = keyof typeof registry;
type Registry = typeof registry;

type TemplateProps = {
	[K in RegistryKey]: {
		componentName: K;
		props: ComponentProps<Registry[K]["component"]>;
	};
}[RegistryKey];

export default function Template({ componentName, props }: TemplateProps) {
	const registryItem = registry[componentName];
	if (!registryItem) {
		return null;
	}

	const Component = registryItem.component;
	// @ts-expect-error - This is a valid error, but we are sure that the props are correct
	return <Component {...props} />;
}
