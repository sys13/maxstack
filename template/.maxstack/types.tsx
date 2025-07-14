/**
 * Configuration for a MAXSTACK project.
 */
export type MAXConfig = {
	/** The name of the project */
	name: string
	/** A description of the project */
	description: string
	/** List of standard features included in the project */
	standardFeatures?: StandardFeature[]
	/** List of routes in your app */
	pages?: Page[]
	domainName?: string
}

/**
 * Complete list of standard site-level features.
 */
export type StandardFeature = 'blog' | 'saas-marketing'

/**
 * Represents a page in the application.
 */
export type Page = {
	/** The name of the page */
	name: string
	/** Optional description of the page */
	description?: string
	/** Optional route path for the page */
	routePath?: string
	/** List of components used in the page */
	components?: string[]
	/** Data to show user */
	infoOnPage?: string[]
	/** List of user actions that can be performed on the page */
	userActions?: string[]
	/** Whether authentication is required to access the page */
	authRequired?: boolean
}
