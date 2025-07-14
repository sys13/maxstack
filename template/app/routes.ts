import { index, route, type RouteConfig } from '@react-router/dev/routes'

export default [
	index('routes/home.tsx'),
	route('*', './catchall.tsx'),
	route('/api/auth/*', 'routes/auth-handler.ts'),
	route('/healthcheck', 'routes/healthcheck.tsx'),
	route('/login', 'routes/login.tsx'),
	route('/signup', 'routes/signup.tsx'),
	route('/verify-email', 'routes/verify-email.tsx'),
	route('/forgot-password', 'routes/forgot-password.tsx'),
	route('/reset-password', 'routes/reset-password.tsx'),
] satisfies RouteConfig
