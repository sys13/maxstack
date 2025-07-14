import type { MAXConfig } from '.maxstack/types'

export default {
	name: '',
	description: '',
	standardFeatures: [],
	pages: [
		{
			name: 'Home',
			description: 'The main landing page of the application',
			routePath: '/',
			components: ['Header', 'Footer', 'MainContent'],
			infoOnPage: ['Welcome message', 'Latest news'],
			userActions: ['Sign Up', 'Login', 'Contact Us'],
			authRequired: false,
		},
	],
} as const satisfies MAXConfig
