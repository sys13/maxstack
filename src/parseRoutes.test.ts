import { describe, expect, it } from 'vitest'

import { parseRoutes } from './parseRoutes.js'

describe('parseRoutes', () => {
	it('parses routes correctly', () => {
		const results = parseRoutes(sample)
		expect(results).toEqual(result)
	})

	it('parses complex routes with layout and prefix', () => {
		const results = parseRoutes(complexSample)
		expect(results).toEqual(complexResult)
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

const complexSample = `import {
  type RouteConfig,
  route,
  layout,
  index,
  prefix,
} from "@react-router/dev/routes";

export default [
  layout("./marketing/layout.tsx", [
    index("./marketing/home.tsx"),
    route("contact", "./marketing/contact.tsx"),
  ]),
  ...prefix("projects", [
    index("./projects/home.tsx"),
    layout("./projects/project-layout.tsx", [
      route(":pid", "./projects/project.tsx"),
      route(":pid/edit", "./projects/edit-project.tsx"),
    ]),
  ]),
] satisfies RouteConfig;
`

const complexResult = [
	{
		filePath: './marketing/home.tsx',
		layout: './marketing/layout.tsx',
		route: '/',
	},
	{
		filePath: './marketing/contact.tsx',
		layout: './marketing/layout.tsx',
		route: '/contact',
	},
	{
		filePath: './projects/home.tsx',
		route: '/projects',
	},
	{
		filePath: './projects/project.tsx',
		layout: './projects/project-layout.tsx',
		route: '/projects/:pid',
	},
	{
		filePath: './projects/edit-project.tsx',
		layout: './projects/project-layout.tsx',
		route: '/projects/:pid/edit',
	},
]
