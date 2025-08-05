import { describe, expect, it } from 'vitest'

import { MAXConfig } from './msZod.js'
import { parseMaxstack } from './parseMs.js'

describe('parseMaxstack', () => {
	it('should return the default MAXConfig object', async () => {
		const config: MAXConfig = await parseMaxstack(
			'tests/maxstack-configs/test1.tsx',
		)
		expect(config).toEqual({
			description: '',
			name: '',
			pages: [
				{
					authRequired: false,
					components: ['Header', 'Footer', 'MainContent'],
					description: 'The main landing page of the application',
					infoOnPage: ['Welcome message', 'Latest news'],
					name: 'Home',
					routePath: '/',
					userActions: ['Sign Up', 'Login', 'Contact Us'],
				},
			],
			standardFeatures: [],
		})
	})
})
