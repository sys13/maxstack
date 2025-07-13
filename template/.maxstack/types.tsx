/**
 * Configuration for a MAXSTACK project.
 */
export type MAXConfig = {
	/** The name of the project */
	name: string;
	/** A description of the project */
	description: string;
	/** How to license the source code */
	license?: "MIT" | "closed-source" | "BSD" | "ISC" | "GPL" | "AGPL" | string;
	/** List of standard features included in the project */
	standardFeatures?: StandardFeature[];
	/** List of type of people that would use your app */
	personas?: (Persona | string)[];
	/** List of features */
	features?: (Feature | string)[];
	/** List of routes in your app */
	pages?: (Page | string)[];
	/** Array of database models (objects or strings) in the project */
	models?: (Model | string)[];
	/** List of unit tests */
	unitTests?: string[];
	/** List of end-to-end tests */
	e2eTests?: (E2ETest | string)[];
	/** What your app will look like */
	style?: Style | string;
	/** Marketing direction and copy */
	marketing?: Marketing | string;
	/** Blog config */
	blog?: {
		enabled: boolean;
		categories?: string[];
		posts?: BlogPostMeta[];
	};
	resources?: {
		whitePapers?: ResourceItem[];
		webinars?: WebinarItem[];
		guides?: ResourceItem[];
	};
	newsletter?: {
		provider:
			| "mailchimp"
			| "convertkit"
			| "customer.io"
			| "postmark"
			| "resend";
		listId: string;
		landingPageUrl?: string;
		defaultOptInCopy?: string;
	};
	/** Navigation */
	navigation?: {
		primary: NavItem[];
		secondary?: NavItem[];
		footer?: FooterColumn[];
		socialLinks?: SocialLink[];
	};
	ctas?: {
		primary: CTA;
		secondary?: CTA;
		exitIntentModal?: Modal;
		announcementBar?: Announcement;
		cookieConsent?: CookieConsent;
	};
	trust?: {
		gdprCompliant?: boolean;
		soc2Type2?: boolean;
		iso27001?: boolean;
		encryption?: "atRest" | "inTransit" | "both";
		badges?: TrustBadge[];
	};
	faq?: FAQItem[];
	pressKit?: {
		aboutBlurb: string;
		logoPackUrl: string;
		screenshotsUrl?: string;
	};
	/** Pricing info */
	pricing?: {
		plans: PricingPlan[];
		discountBanner?: DiscountBanner;
	};

	integrations?: {
		analytics: AnalyticsIds;
		chatWidget?: {
			provider:
				| "intercom"
				| "crisp"
				| "drift"
				| "papercups"
				| "tawk"
				| "custom";
			appId: string;
		};
		reviewWidget?: {
			provider: "capterra" | "g2" | "trustpilot" | "custom";
			scriptUrl: string;
		};
		scheduler?: {
			provider: "calendly" | "savvycal" | "hubspot" | "custom";
			url: string;
		};
	};
	domainName?: string;
};

/**
 * Complete list of standard site-level features.
 */
export type StandardFeature =
	| "a-b-testing"
	| "accessibility"
	| "admin-dashboard"
	| "analytics-dashboard"
	| "api-access"
	| "audit-logging"
	| "backup-restore"
	| "billing-subscriptions"
	| "blog"
	| "content-management"
	| "customer-support"
	| "data-export-import"
	| "dark-mode-toggle"
	| "e-commerce"
	| "email-marketing"
	| "event-management"
	| "file-storage"
	| "form-builder"
	| "gdpr-compliance"
	| "knowledge-base"
	| "live-chat"
	| "media-management"
	| "multi-language-support"
	| "notifications"
	| "offline-support"
	| "payment-processing"
	| "performance-monitoring"
	| "portfolio"
	| "project-management"
	| "push-notifications"
	| "rate-limiting"
	| "role-based-access-control"
	| "saas-marketing"
	| "search"
	| "seo-optimization"
	| "social-networking"
	| "two-factor-auth"
	| "user-authentication"
	| "webhooks";

/**
 * Represents a user persona for the application.
 */
export type Persona = {
	/** The name of the persona */
	name: string;
	/** Optional description of the persona */
	description?: string;
	/** List of jobs the persona needs to accomplish, like tasks the user would do */
	jobsToBeDone?: string[];
	/** List of pain points or challenges faced by the persona */
	painPoints?: string[];
	/** List of user stories for the persona */
	userStories?: string[];
	/** Priority level (low, medium, high) */
	priority?: Priority;
	/** Current status (planned, in-progress, completed) */
	status?: "planned" | "in-progress" | "completed";
};

/**
 * Represents a feature in the application.
 */
export type Feature = {
	/** The name of the feature */
	name: string;
	/** Optional description of the feature */
	description?: string;
	/** List of goals for the feature */
	goals?: string | string[];
	/** List of user stories for the feature */
	userStories?: string | string[];
	/** Priority level (low, medium, high) */
	priority?: Priority;
	/** Current status (planned, in-progress, completed) */
	status?: Status;
	/** List of dependencies for the feature */
	dependencies?: string | string[];
	/** List of tags for the feature */
	tags?: string | string[];
};

/**
 * Represents a page in the application.
 */
export type Page = {
	/** The name of the page */
	name: string;
	/** Optional description of the page */
	description?: string;
	/** Optional route path for the page */
	routePath?: string;
	/** List of components used in the page */
	components?: string[];
	/** Data to show user */
	infoOnPage?: string[];
	/** List of user actions that can be performed on the page */
	userActions?: string[];
	/** Priority level (low, medium, high) */
	priority?: Priority;
	/** Current status */
	status?: Status;
	/** List of tags for the page */
	tags?: string[];
	/** Whether authentication is required to access the page */
	authRequired?: boolean;
};

/**
 * Represents a data model in the application.
 */
export type Model = {
	/** The name of the model */
	name: string;
	/** Optional description of the model */
	description?: string;
	/** List of field names for the model */
	fields?: (ModelField | string)[];
	/** List of relationships for the model */
	relationships?: RelationshipField | RelationshipField[];
	/** Priority level (low, medium, high) */
	priority?: "low" | "medium" | "high";
	/** Current status (planned, in-progress, completed) */
	status?: Status;
	/** List of tags for the model */
	tags?: string[];
};

/**
 * Represents a field in a data model.
 */
export type ModelField = {
	/** The name of the field */
	name: string;
	/** The data type of the field */
	type?:
		| "integer"
		| "real"
		| "string"
		| "boolean"
		| "date"
		| "datetime"
		| "time"
		| "json"
		| "enum"
		| "relation";
	/** Whether the field is a primary key */
	primaryKey?: boolean; // For primary keys
	/** Whether the primary key is auto-incrementing */
	primaryKeyAutoIncrement?: boolean; // For auto-incrementing primary keys
	/** Enum values if the type is 'enum' */
	enumValues?: string[]; // For enum types
	/** Optional description of the field */
	description?: string;
	/** Whether the field is not nullable */
	notNull?: boolean;
	/** Default value for the field */
	// biome-ignore lint/suspicious/noExplicitAny: arbitrary data type
	defaultValue?: any;
	/** List of validation rules for the field
	 * Example: ['minLength:3', 'maxLength:255']
	 */
	validations?: string[];
};

export type RelationshipField = {
	/** The name of the field */
	name?: string;
	/** The type of relationship */
	type: "one-to-one" | "one-to-many";
	/** The related model */
	relatedModel: string;
	/** Optional description of the relationship */
	description?: string;
};

/**
 * Tasks for you to complete in the project.
 */
export type Task = {
	/** The name of the task */
	name: string;
	/** Optional description of the task */
	description?: string;
	/** Priority level (low, medium, high) */
	priority?: "low" | "medium" | "high";
	/** Current status (planned, in-progress, completed) */
	status?: Status;
	/** List of tags for the task */
	tags?: string[];
	/** List of dependencies for the task */
	dependencies?: string[];
	/** Estimated time to complete the task in hours */
	estimatedTime?: number;
};

/**
 * Priority levels
 */
export type Priority = "low" | "medium" | "high";

// This is a type for a task that can be a string or an object with more details
export type Status = "todo" | "in-progress" | "completed" | "blocked";

/**
 * A list of tasks, which can be either strings or Task objects.
 * This allows for flexibility in defining tasks, where some tasks may be simple strings
 * while others may require more detailed information.
 */
export type TaskList = (Task | string)[];

export type E2ETest = {
	/** The name of the test */
	name: string;
	/** Optional description of the test */
	description?: string;
	/** List of test cases to be executed */
	testCases?: string[];
	/** What features is this relevant to */
	features?: (Feature | string)[];
	/** Priority level (low, medium, high) */
	priority?: Priority;
	/** Current status (planned, in-progress, completed) */
	status?: Status;
	/** List of tags for the test */
	tags?: string[];
};

export type Style = {
	designDirection?: DesignDirection | DesignDirection[];
	brandTone?: BrandTone | BrandTone[];
	colorPalette?: (PaletteColor | string)[];
};

type DesignDirection =
	| "modern"
	| "contemporary"
	| "classic"
	| "futuristic"
	| "brutalist"
	| "corporate"
	| "playful"
	| "minimalist"
	| "maximalist"
	| "skeuomorphic";

type BrandTone =
	| "professional"
	| "casual"
	| "trustworthy"
	| "bold"
	| "friendly"
	| "efficient"
	| "premium"
	| "approachable";

export type PaletteColor = {
	type: "primary" | "secondary" | "accent" | "background" | "text";
	description?: string;
	cssValue?: string;
	cssValueDark?: string;
};

export type Marketing = {
	siteTitle: string;
	siteDescription: string;
	hero: HeroBlock;
	brandVoice?: string;
	/** List of marketing channels to be used */
	testimonials?: Testimonial[];
	logos?: LogoWallItem[];
	caseStudies?: CaseStudy[];
};

export type MarketingChannel =
	| "social-media"
	| "email"
	| "content-marketing"
	| "seo"
	| "paid-ads"
	| "influencer"
	| "events"
	| "partnerships"
	| "referral"
	| "other";

export type NavItem = {
	label: string;
	href: string;
	icon?: string; // Lucide/FontAwesome key
	targetBlank?: boolean;
	badge?: string; // e.g. "New"
};

export type FooterColumn = {
	heading: string;
	links: NavItem[];
};

export type SocialLink = {
	platform:
		| "twitter"
		| "linkedin"
		| "github"
		| "youtube"
		| "discord"
		| "facebook"
		| "instagram"
		| "tiktok"
		| "threads"
		| "rss"
		| string;
	href: string;
	icon?: string;
};

export type HeroBlock = {
	headline: string;
	subheadline?: string;
	primaryCTA: CTA;
	secondaryCTA?: CTA;
	media?: {
		type: "image" | "video" | "illustration" | "code" | "screenshot";
		src: string;
		alt?: string;
		autoplay?: boolean;
		loop?: boolean;
	};
	badges?: string[]; // e.g. “#1 on Product Hunt”
};

export type PricingPlan = {
	id: string;
	name: string;
	price: number; // e.g. 29.00 (monthly)
	priceInterval: "monthly" | "yearly" | "lifetime";
	description?: string;
	highlight?: boolean; // “Most popular”
	featuresIncluded: string[];
	cta: CTA;
	trialDays?: number;
	// stripePriceId?: string
};

export type DiscountBanner = {
	text: string; // “Save 20% — summer sale”
	endsAt?: string; // ISO date
	cta?: CTA;
};

export type Testimonial = {
	quote: string;
	author: {
		name: string;
		title?: string;
		company?: string;
		avatarUrl?: string;
		logoUrl?: string;
	};
	rating?: number; // 1-5 stars
	videoUrl?: string;
};

export type LogoWallItem = {
	name: string;
	logoUrl: string;
	href?: string;
};

export type CaseStudy = {
	slug: string;
	title: string;
	summary: string;
	heroImage: string;
	pdfUrl?: string;
	stats?: { label: string; value: string }[];
};

export type BlogPostMeta = {
	slug: string;
	title: string;
	summary: string;
	publishedAt: string; // ISO date
	coverImage?: string;
	tags?: string[];
	readingMinutes?: number;
	author?: string;
};

export type ResourceItem = {
	title: string;
	slug: string;
	type: "pdf" | "ebook" | "guide" | "cheatsheet";
	description?: string;
	coverImage?: string;
	fileUrl: string;
	gated?: boolean; // requires email?
};

export type WebinarItem = {
	title: string;
	scheduledFor: string; // ISO date/time
	durationMinutes: number;
	recordingUrl?: string;
	host: string;
	guests?: string[];
	registrationCta: CTA;
};

export type CTA = {
	label: string;
	href: string;
	targetBlank?: boolean;
	style?: "primary" | "secondary" | "ghost";
	trackingId?: string; // for analytics
};

export type Modal = {
	id: string;
	title: string;
	bodyHtml: string; // allow rich text
	cta: CTA;
	showDelaySeconds?: number; // 0 = immediate
	frequency: "once" | "daily" | "session";
};

export type Announcement = {
	id: string;
	text: string;
	cta?: CTA;
	style?: "info" | "success" | "warning" | "error";
	dismissible?: boolean;
};

export type CookieConsent = {
	message: string;
	acceptLabel: string;
	declineLabel?: string;
	learnMoreUrl?: string;
};

export type Experiment = {
	id: string;
	name: string;
	description?: string;
	variants: ("A" | "B" | "C" | string)[];
	metric: string; // e.g. "signup_conversion"
	trafficSplit: number[]; // must match variants
	startDate: string;
	endDate?: string;
};

export type AnalyticsIds = {
	googleAnalyticsId?: string;
	gtmId?: string;
	segmentWriteKey?: string;
	mixpanelToken?: string;
	plausibleDomain?: string;
	posthogKey?: string;
	facebookPixelId?: string;
	linkedinPartnerId?: string;
};

export type TrustBadge = {
	label: string; // “GDPR Ready”
	iconUrl?: string;
	href?: string;
};

export type FAQItem = {
	question: string;
	answerHtml: string;
	category?: string;
};
