import { describe, expect, it } from 'vitest'

import { parseRoutes } from './parseRoutes.js'

describe('parseRoutes', () => {
	it('parses routes correctly', () => {
		const results = parseRoutes(sample)
		expect(results).toEqual(result)
	})
})

const sample = `import { index, route, type RouteConfig, } from '@react-router/dev/routes'

export default [
	index('routes/home.tsx'),
	route('*', './catchall.tsx'),
	route('/reset-password', 'routes/reset-password.tsx'),
] satisfies RouteConfig
`

const result = [
	{
		filePath: 'routes/home.tsx',
		route: '/',
	},
	{
		filePath: './catchall.tsx',
		route: '*',
	},
	{
		filePath: 'routes/reset-password.tsx',
		route: '/reset-password',
	},
]
