import { index, route, type RouteConfig } from '@react-router/dev/routes'

export default [
	index('routes/home.tsx'),
	route('*', './catchall.tsx'),
	route('/api/auth/*', 'routes/auth-handler.ts'),
	route('/healthcheck', 'routes/healthcheck.tsx'),
] satisfies RouteConfig
