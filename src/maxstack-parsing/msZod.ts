import { z } from 'zod'

export const StandardFeatureSchema = z
	.enum(['blog', 'saas-marketing'])
	.describe('Complete list of standard site-level features')

const templateComponents = z.enum([
	'about',
	'blogCreate',
	'blogEdit',
	'blogLanding',
	'blogPost',
	'blogTags',
	'contact',
	'faq',
	'landing',
	'marketingFooter',
	'marketingNav',
	'maxstackWelcome',
	'newsletterSignup',
	'pricing',
	'privacyPolicy',
	'termsOfService',
])

/**
 * Represents a page in the application.
 */
export const PageSchema = z
	.object({
		authRequired: z
			.boolean()
			.optional()
			.describe('Whether authentication is required to access the page'),
		components: z
			.array(z.string())
			.optional()
			.describe('List of components used in the page'),
		description: z
			.string()
			.optional()
			.describe('Optional description of the page'),
		infoOnPage: z.array(z.string()).optional().describe('Data to show user'),
		name: z.string().describe('Name of the page'),
		routePath: z.string().describe('Optional route path for the page'),
		templateComponents: z
			.array(templateComponents)
			.optional()
			.describe('List of components that already have templates'),
		userActions: z
			.array(z.string())
			.optional()
			.describe('List of user actions that can be performed on the page'),
	})
	.describe('Your routes and components')

/**
 * Configuration for a MAXSTACK project.
 */
export const MAXConfigSchema = z.object({
	description: z.string().describe('A brief description of the project'),
	domainName: z.string().optional().describe('The main production domain name'),
	name: z.string().describe('The name of the project'),
	pages: z.array(PageSchema).optional().describe('List of routes in your app'),
	standardFeatures: z
		.array(StandardFeatureSchema)
		.optional()
		.describe('List of standard features included in the project'),
})

// Export the inferred types for convenience
export type MAXConfig = z.infer<typeof MAXConfigSchema>
export type Page = z.infer<typeof PageSchema>
export type StandardFeature = z.infer<typeof StandardFeatureSchema>
