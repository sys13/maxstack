export const saasMarketingFeatureConfig = {
	name: 'saas-marketing',
	description:
		'Marketing pages and user preference system for SaaS applications',
	models: [
		{
			name: 'userPreferences',
			description: 'User email and notification preferences',
			fields: [
				'id',
				'userId',
				'newsletter',
				'productUpdates',
				'taskReminders',
				'accountNotifications',
				'marketingEmails',
				'createdAt',
				'updatedAt',
			],
		},
	],
	pages: [
		{
			name: 'About',
			routePath: '/about',
			description: 'Learn more about our company and mission',
			authRequired: false,
		},
		{
			name: 'Features',
			routePath: '/features',
			description: 'Discover powerful features',
			authRequired: false,
		},
		{
			name: 'Pricing',
			routePath: '/pricing',
			description: 'View pricing plans and options',
			authRequired: false,
		},
		{
			name: 'Contact',
			routePath: '/contact',
			description: 'Get in touch with our team',
			authRequired: false,
		},
	],
	components: ['FeatureCard', 'PricingCard', 'ContactForm', 'NewsletterSignup'],
	dependencies: ['user'], // Depends on user system for preferences
} as const
