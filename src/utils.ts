import {
	copyFileSync,
	existsSync,
	mkdirSync,
	readdirSync,
	readFileSync,
	statSync,
	writeFileSync,
} from 'fs'
import { resolve } from 'path'

/**
 * Copy a directory and its contents recursively
 */
export function copyDirRecursive(src: string, dest: string): void {
	if (!existsSync(dest)) {
		mkdirSync(dest, { recursive: true })
	}
	for (const entry of readdirSync(src)) {
		const srcPath = resolve(src, entry)
		const destPath = resolve(dest, entry)
		if (statSync(srcPath).isDirectory()) {
			copyDirRecursive(srcPath, destPath)
		} else {
			copyFileSync(srcPath, destPath)
		}
	}
}

/**
 * Generate a MAXSTACK configuration template
 */
export function generateConfigTemplate(
	templateType: string,
	projectName: string,
	projectDescription: string,
	selectedFeatures?: string[],
): string {
	const featuresArray =
		selectedFeatures && selectedFeatures.length > 0
			? `["${selectedFeatures.join('", "')}"]`
			: '[]'

	const templates = {
		default: `import type { MAXConfig } from "./.maxstack/types";

export default {
	name: "${projectName}",
	description: "${projectDescription}",
	standardFeatures: ${featuresArray},
	personas: [],
	features: [],
	pages: [],
	models: [],
	unitTests: [],
	e2eTests: [],
} as const satisfies MAXConfig;
`,
	}

	return templates[templateType as keyof typeof templates] || templates.default
}

/**
 * Convert a string to kebab-case
 */
export function toKebabCase(str: string): string {
	return str
		.trim()
		.toLowerCase()
		.replace(/[_\s]+/g, '-') // Convert underscores and spaces to hyphens
		.replace(/[^a-z0-9-]/g, '') // Remove special characters except hyphens
		.replace(/-+/g, '-') // Replace multiple hyphens with single hyphen
		.replace(/^-|-$/g, '') // Remove leading/trailing hyphens
}

/**
 * Update a file with replacements
 */
export function updateFileWithReplacements(
	filePath: string,
	replacements: Record<string, string>,
): void {
	if (!existsSync(filePath)) {
		return
	}

	try {
		let content = readFileSync(filePath, 'utf8')

		for (const [placeholder, replacement] of Object.entries(replacements)) {
			content = content.replace(new RegExp(placeholder, 'g'), replacement)
		}

		writeFileSync(filePath, content, 'utf8')
	} catch (error) {
		console.error(`❌ Failed to update ${filePath}:`, (error as Error).message)
	}
}

/**
 * Generate types content for .maxstack/types.ts
 */
export function generateTypesContent(): string {
	return `/**
 * Configuration for a MAXSTACK project.
 */
export interface MAXConfig {
	/** The name of the project */
	name: string;
	/** A description of the project */
	description: string;
	/** How to license the source code */
	license?: "AGPL" | "BSD" | "closed-source" | "GPL" | "ISC" | "MIT";
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
	style?: string | Style;
	/** Marketing direction and copy */
	marketing?: Marketing | string;
	/** Blog config */
	blog?: {
		categories?: string[];
		enabled: boolean;
		posts?: BlogPostMeta[];
	};
	newsletter?: {
		defaultOptInCopy?: string;
		landingPageUrl?: string;
		listId: string;
		provider:
			| "convertkit"
			| "customer.io"
			| "mailchimp"
			| "postmark"
			| "resend";
	};
	resources?: {
		guides?: ResourceItem[];
		webinars?: WebinarItem[];
		whitePapers?: ResourceItem[];
	};
	/** Navigation */
	ctas?: {
		announcementBar?: Announcement;
		cookieConsent?: CookieConsent;
		exitIntentModal?: Modal;
		primary: CTA;
		secondary?: CTA;
	};
	faq?: FAQItem[];
	navigation?: {
		footer?: FooterColumn[];
		primary: NavItem[];
		secondary?: NavItem[];
		socialLinks?: SocialLink[];
	};
	pressKit?: {
		aboutBlurb: string;
		logoPackUrl: string;
		screenshotsUrl?: string;
	};
	trust?: {
		badges?: TrustBadge[];
		encryption?: "atRest" | "both" | "inTransit";
		gdprCompliant?: boolean;
		iso27001?: boolean;
		soc2Type2?: boolean;
	};
	/** Pricing info */
	integrations?: {
		analytics: AnalyticsIds;
		chatWidget?: {
			appId: string;
			provider:
				| "crisp"
				| "custom"
				| "drift"
				| "intercom"
				| "papercups"
				| "tawk";
		};
		reviewWidget?: {
			provider: "capterra" | "custom" | "g2" | "trustpilot";
			scriptUrl: string;
		};
		scheduler?: {
			provider: "calendly" | "custom" | "hubspot" | "savvycal";
			url: string;
		};
	};

	pricing?: {
		comparisonTable?: FeatureMatrix;
		discountBanner?: DiscountBanner;
		plans: PricingPlan[];
	};
}

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
	| "dark-mode-toggle"
	| "data-export-import"
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
export interface Persona {
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
	status?: "completed" | "in-progress" | "planned";
}

/**
 * Represents a feature in the application.
 */
export interface Feature {
	/** The name of the feature */
	name: string;
	/** Optional description of the feature */
	description?: string;
	/** List of goals for the feature */
	goals?: string[];
	/** List of user stories for the feature */
	userStories?: string[];
	/** Priority level (low, medium, high) */
	priority?: Priority;
	/** Current status (planned, in-progress, completed) */
	status?: Status;
	/** List of dependencies for the feature */
	dependencies?: string[];
	/** List of tags for the feature */
	tags?: string[];
}

/**
 * Represents a page in the application.
 */
export interface Page {
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
}

/**
 * Represents a data model in the application.
 */
export interface Model {
	/** The name of the model */
	name: string;
	/** Optional description of the model */
	description?: string;
	/** List of field names for the model */
	fields?: (ModelField | string)[];
	/** List of relationships for the model */
	relationships?: string[];
	/** Priority level (low, medium, high) */
	priority?: "high" | "low" | "medium";
	/** Current status (planned, in-progress, completed) */
	status?: Status;
	/** List of tags for the model */
	tags?: string[];
}

/**
 * Represents a field in a data model.
 */
export interface ModelField {
	/** The name of the field */
	name: string;
	/** The data type of the field */
	type?:
		| "boolean"
		| "date"
		| "datetime"
		| "enum"
		| "integer"
		| "json"
		| "real"
		| "relation"
		| "string"
		| "time";
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
	// eslint-disable-next-line @typescript-eslint/no-explicit-any
	defaultValue?: any;

	/**
	 * List of validation rules for the field
	 * Example: ['minLength:3', 'maxLength:255']
	 */
	validations?: string[];
	/** Name of the related model if type is 'relation' */
	relatedModel?: string; // For relationships
}

/**
 * Tasks for you to complete in the project.
 */
export interface Task {
	/** The name of the task */
	name: string;
	/** Optional description of the task */
	description?: string;
	/** Priority level (low, medium, high) */
	priority?: "high" | "low" | "medium";
	/** Current status (planned, in-progress, completed) */
	status?: Status;
	/** List of tags for the task */
	tags?: string[];
	/** List of dependencies for the task */
	dependencies?: string[];
	/** Estimated time to complete the task in hours */
	estimatedTime?: number;
}

/**
 * Priority levels
 */
export type Priority = "high" | "low" | "medium";

// This is a type for a task that can be a string or an object with more details
export type Status = "blocked" | "completed" | "in-progress" | "todo";

/**
 * A list of tasks, which can be either strings or Task objects.
 * This allows for flexibility in defining tasks, where some tasks may be simple strings
 * while others may require more detailed information.
 */
export interface AnalyticsIds {
	facebookPixelId?: string;
	googleAnalyticsId?: string;
	gtmId?: string;
	linkedinPartnerId?: string;
	mixpanelToken?: string;
	plausibleDomain?: string;
	posthogKey?: string;
	segmentWriteKey?: string;
}

export interface Announcement {
	cta?: CTA;
	dismissible?: boolean;
	id: string;
	style?: "error" | "info" | "success" | "warning";
	text: string;
}

export interface BlogPostMeta {
	author?: string;
	coverImage?: string;
	publishedAt: string; // ISO date
	readingMinutes?: number;
	slug: string;
	summary: string;
	tags?: string[];
	title: string;
}

export interface CaseStudy {
	heroImage: string;
	pdfUrl?: string;
	slug: string;
	stats?: { label: string; value: string }[];
	summary: string;
	title: string;
}

export interface CookieConsent {
	acceptLabel: string;
	declineLabel?: string;
	learnMoreUrl?: string;
	message: string;
}

export interface CTA {
	href: string;
	label: string;
	style?: "ghost" | "primary" | "secondary";
	targetBlank?: boolean;
	trackingId?: string; // for analytics
}

export interface DiscountBanner {
	cta?: CTA;
	endsAt?: string; // ISO date
	text: string; // "Save 20% — summer sale"
}

export interface E2ETest {
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
}

export interface Experiment {
	description?: string;
	endDate?: string;
	id: string;
	metric: string; // e.g. "signup_conversion"
	name: string;
	startDate: string;
	trafficSplit: number[]; // must match variants
	variants: ("A" | "B" | "C")[];
}

export interface FAQItem {
	answerHtml: string;
	category?: string;
	question: string;
}

export interface FeatureBlock {
	bullets?: {
		icon?: string;
		text: string;
	}[];
	description?: string;
	eyebrow?: string;
	icon?: string;
	id: string;
	media?: HeroBlock["media"];
	title: string;
}

export interface FeatureMatrix {
	availability: Record<string, boolean[]>; // key = feature, value = per-plan boolean
	features: string[];
	plans: string[]; // plan ids in order
}

export interface FooterColumn {
	heading: string;
	links: NavItem[];
}

export interface HeroBlock {
	badges?: string[]; // e.g. "#1 on Product Hunt"
	headline: string;
	media?: {
		alt?: string;
		autoplay?: boolean;
		loop?: boolean;
		src: string;
		type: "code" | "illustration" | "image" | "screenshot" | "video";
	};
	primaryCTA: CTA;
	secondaryCTA?: CTA;
	subheadline?: string;
}

export interface LogoWallItem {
	href?: string;
	logoUrl: string;
	name: string;
}

export interface Marketing {
	brandVoice?: string;
	hero: HeroBlock;
	siteDescription: string;
	siteTitle: string;
	/** List of marketing channels to be used */
	caseStudies?: CaseStudy[];
	logos?: LogoWallItem[];
	testimonials?: Testimonial[];
}

export type MarketingChannel =
	| "content-marketing"
	| "email"
	| "events"
	| "influencer"
	| "other"
	| "paid-ads"
	| "partnerships"
	| "referral"
	| "seo"
	| "social-media";

export interface Modal {
	bodyHtml: string; // allow rich text
	cta: CTA;
	frequency: "daily" | "once" | "session";
	id: string;
	showDelaySeconds?: number; // 0 = immediate
	title: string;
}

export interface NavItem {
	badge?: string; // e.g. "New"
	href: string;
	icon?: string; // Lucide/FontAwesome key
	label: string;
	targetBlank?: boolean;
}

export interface PaletteColor {
	cssValue?: string;
	cssValueDark?: string;
	description?: string;
	type: "accent" | "background" | "primary" | "secondary" | "text";
}

export interface PricingPlan {
	cta: CTA;
	description?: string;
	featuresIncluded: string[];
	highlight?: boolean; // "Most popular"
	id: string;
	name: string;
	price: number; // e.g. 29.00 (monthly)
	priceInterval: "lifetime" | "monthly" | "yearly";
	quotas?: Record<string, number>; // e.g. { seats: 5, projects: 50 }
	stripePriceId?: string;
	trialDays?: number;
}

export interface ResourceItem {
	coverImage?: string;
	description?: string;
	fileUrl: string;
	gated?: boolean; // requires email?
	slug: string;
	title: string;
	type: "cheatsheet" | "ebook" | "guide" | "pdf";
}

export interface SocialLink {
	href: string;
	icon?: string;
	platform:
		| "discord"
		| "facebook"
		| "github"
		| "instagram"
		| "linkedin"
		| "rss"
		| "threads"
		| "tiktok"
		| "twitter"
		| "youtube";
}

export interface Style {
	brandTone?: BrandTone | BrandTone[];
	colorPalette?: (PaletteColor | string)[];
	designDirection?: DesignDirection | DesignDirection[];
}

export type TaskList = (string | Task)[];

export interface Testimonial {
	author: {
		avatarUrl?: string;
		company?: string;
		logoUrl?: string;
		name: string;
		title?: string;
	};
	quote: string;
	rating?: number; // 1-5 stars
	videoUrl?: string;
}

export interface TrustBadge {
	href?: string;
	iconUrl?: string;
	label: string; // "GDPR Ready"
}

export interface WebinarItem {
	durationMinutes: number;
	guests?: string[];
	host: string;
	recordingUrl?: string;
	registrationCta: CTA;
	scheduledFor: string; // ISO date/time
	title: string;
}

type BrandTone =
	| "approachable"
	| "bold"
	| "casual"
	| "efficient"
	| "friendly"
	| "premium"
	| "professional"
	| "trustworthy";

type DesignDirection =
	| "brutalist"
	| "classic"
	| "contemporary"
	| "corporate"
	| "futuristic"
	| "maximalist"
	| "minimalist"
	| "modern"
	| "playful"
	| "skeuomorphic";
`
}
