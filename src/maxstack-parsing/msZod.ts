import { z } from 'zod'

/**
 * Complete list of standard site-level features.
 */
export const StandardFeatureSchema = z.enum(['blog', 'saas-marketing'])

/**
 * Represents a page in the application.
 */
export const PageSchema = z.object({
	/** The name of the page */
	name: z.string(),
	/** Optional description of the page */
	description: z.string().optional(),
	/** Optional route path for the page */
	routePath: z.string().optional(),
	/** List of components used in the page */
	components: z.array(z.string()).optional(),
	/** Data to show user */
	infoOnPage: z.array(z.string()).optional(),
	/** List of user actions that can be performed on the page */
	userActions: z.array(z.string()).optional(),
	/** Whether authentication is required to access the page */
	authRequired: z.boolean().optional(),
})

/**
 * Configuration for a MAXSTACK project.
 */
export const MAXConfigSchema = z.object({
	/** The name of the project */
	name: z.string(),
	/** A description of the project */
	description: z.string().describe('A brief description of the project'),
	domainName: z.string().optional(),
	/** List of routes in your app */
	pages: z.array(PageSchema).optional(),
	/** List of standard features included in the project */
	standardFeatures: z.array(StandardFeatureSchema).optional(),
})

// Export the inferred types for convenience
export type MAXConfig = z.infer<typeof MAXConfigSchema>
export type Page = z.infer<typeof PageSchema>
export type StandardFeature = z.infer<typeof StandardFeatureSchema>
