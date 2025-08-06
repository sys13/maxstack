import { describe, expect, it } from 'vitest'

import type { Page } from '../maxstack-parsing/msZod.js'

import { createRouteText } from './createRoute.js'

describe('createRouteText', () => {
	it('creates a basic route with minimal page data', () => {
		const page: Page = {
			name: 'HomePage',
			routePath: '/',
		}

		const result = createRouteText(page)

		expect(result.fileName).toBe('home-page.tsx')
		expect(result.fileString)
			.toBe(`import Template, { registry } from '~/components/templates/template'
import type { Route } from './+types/home-page'

export default function HomePagePage({}: Route.ComponentProps ) {
	return (
		<>
			
		</>
	)
}`)
	})

	it('creates a route with all optional fields populated', () => {
		const page: Page = {
			authRequired: true,
			components: ['ProfileForm', 'AvatarUpload'],
			description: 'User profile page for managing account settings',
			infoOnPage: ['user details', 'settings'],
			name: 'UserProfile',
			routePath: '/profile',
			templateComponents: ['about', 'contact'],
			userActions: ['edit profile', 'change password'],
		}

		const result = createRouteText(page)

		expect(result.fileName).toBe('user-profile.tsx')
		expect(result.fileString)
			.toBe(`import Template, { registry } from '~/components/templates/template'
import type { Route } from './+types/user-profile'

// description: User profile page for managing account settings
// components used in the page: ProfileForm,AvatarUpload
// data to show user: user details,settings
// user actions: edit profile,change password
// auth required: yes
export default function UserProfilePage({}: Route.ComponentProps ) {
	return (
		<>
			<Template componentName="about" />
<Template componentName="contact" />
		</>
	)
}`)
	})

	it('handles kebab case conversion for complex names', () => {
		const page: Page = {
			name: 'Admin Dashboard Settings',
			routePath: '/admin/dashboard/settings',
		}

		const result = createRouteText(page)

		expect(result.fileName).toBe('admin-dashboard-settings.tsx')
		expect(result.fileString).toContain(
			"import type { Route } from './+types/admin-dashboard-settings'",
		)
		expect(result.fileString).toContain(
			'export default function AdminDashboardSettingsPage({}: Route.ComponentProps ) {',
		)
	})

	it('handles names with special characters', () => {
		const page: Page = {
			name: 'User_Profile & Settings!',
			routePath: '/user-profile-settings',
		}

		const result = createRouteText(page)

		expect(result.fileName).toBe('user-profile-settings.tsx')
		expect(result.fileString).toContain(
			"import type { Route } from './+types/user-profile-settings'",
		)
		expect(result.fileString).toContain(
			'export default function UserProfileSettingsPage({}: Route.ComponentProps ) {',
		)
	})

	it('handles empty arrays for optional fields', () => {
		const page: Page = {
			authRequired: false,
			components: [],
			infoOnPage: [],
			name: 'EmptyPage',
			routePath: '/empty',
			templateComponents: [],
			userActions: [],
		}

		const result = createRouteText(page)

		expect(result.fileName).toBe('empty-page.tsx')
		expect(result.fileString)
			.toBe(`import Template, { registry } from '~/components/templates/template'
import type { Route } from './+types/empty-page'

// auth required: no
export default function EmptyPagePage({}: Route.ComponentProps ) {
	return (
		<>
			
		</>
	)
}`)
	})

	it('handles single template component', () => {
		const page: Page = {
			name: 'LandingPage',
			routePath: '/',
			templateComponents: ['landing'],
		}

		const result = createRouteText(page)

		expect(result.fileName).toBe('landing-page.tsx')
		expect(result.fileString).toContain('<Template componentName="landing" />')
	})

	it('handles multiple template components', () => {
		const page: Page = {
			name: 'MarketingPage',
			routePath: '/marketing',
			templateComponents: [
				'marketingNav',
				'landing',
				'pricing',
				'marketingFooter',
			],
		}

		const result = createRouteText(page)

		expect(result.fileName).toBe('marketing-page.tsx')
		expect(result.fileString).toContain(
			'<Template componentName="marketingNav" />',
		)
		expect(result.fileString).toContain('<Template componentName="landing" />')
		expect(result.fileString).toContain('<Template componentName="pricing" />')
		expect(result.fileString).toContain(
			'<Template componentName="marketingFooter" />',
		)
	})

	it('handles template components with kebab case conversion', () => {
		const page: Page = {
			name: 'BlogPage',
			routePath: '/blog',
			templateComponents: ['blogLanding'],
		}

		const result = createRouteText(page)

		expect(result.fileName).toBe('blog-page.tsx')
		expect(result.fileString).toContain(
			'<Template componentName="blogLanding" props={{ posts }} />',
		)
	})

	it('handles single item arrays', () => {
		const page: Page = {
			authRequired: true,
			components: ['SingleComponent'],
			infoOnPage: ['single info'],
			name: 'SingleItemPage',
			routePath: '/single',
			templateComponents: ['about'],
			userActions: ['single action'],
		}

		const result = createRouteText(page)

		expect(result.fileName).toBe('single-item-page.tsx')
		expect(result.fileString).toContain(
			'// components used in the page: SingleComponent',
		)
		expect(result.fileString).toContain('// data to show user: single info')
		expect(result.fileString).toContain('// user actions: single action')
		expect(result.fileString).toContain('// auth required: yes')
		expect(result.fileString).toContain('<Template componentName="about" />')
	})

	it('handles authRequired false explicitly', () => {
		const page: Page = {
			authRequired: false,
			name: 'PublicPage',
			routePath: '/public',
		}

		const result = createRouteText(page)

		expect(result.fileName).toBe('public-page.tsx')
		expect(result.fileString).toContain('// auth required: no')
	})

	it('handles authRequired true explicitly', () => {
		const page: Page = {
			authRequired: true,
			name: 'ProtectedPage',
			routePath: '/protected',
		}

		const result = createRouteText(page)

		expect(result.fileName).toBe('protected-page.tsx')
		expect(result.fileString).toContain('// auth required: yes')
	})

	it('handles authRequired undefined (defaults to no)', () => {
		const page: Page = {
			name: 'DefaultPage',
			routePath: '/default',
		}

		const result = createRouteText(page)

		expect(result.fileName).toBe('default-page.tsx')
		expect(result.fileString).not.toContain('// auth required')
	})

	it('creates correct file structure with proper imports', () => {
		const page: Page = {
			name: 'TestPage',
			routePath: '/test',
		}

		const result = createRouteText(page)

		expect(result.fileString).toContain(
			"import Template, { registry } from '~/components/templates/template'",
		)
		expect(result.fileString).toContain(
			"import type { Route } from './+types/test-page'",
		)
		expect(result.fileString).toContain(
			'export default function TestPagePage({}: Route.ComponentProps ) {',
		)
		expect(result.fileString).toContain('return (')
		expect(result.fileString).toContain('<>')
		expect(result.fileString).toContain('</>')
		expect(result.fileString).toContain(')')
		expect(result.fileString).toContain('}')
	})

	it('handles complex component names with special formatting', () => {
		const page: Page = {
			name: 'ComplexPage',
			routePath: '/complex',
			templateComponents: [
				'newsletterSignup',
				'privacyPolicy',
				'termsOfService',
			],
		}

		const result = createRouteText(page)

		expect(result.fileName).toBe('complex-page.tsx')
		expect(result.fileString).toContain(
			'<Template componentName="newsletterSignup" />',
		)
		expect(result.fileString).toContain(
			'<Template componentName="privacyPolicy" />',
		)
		expect(result.fileString).toContain(
			'<Template componentName="termsOfService" />',
		)
	})

	it('handles mixed populated and empty fields', () => {
		const page: Page = {
			components: ['Component1'],
			description: 'A page with mixed content',
			name: 'MixedPage',
			routePath: '/mixed',
			// infoOnPage is undefined
			// userActions is undefined
			authRequired: true,
		}

		const result = createRouteText(page)

		expect(result.fileName).toBe('mixed-page.tsx')
		expect(result.fileString).toContain(
			'// description: A page with mixed content',
		)
		expect(result.fileString).toContain(
			'// components used in the page: Component1',
		)
		expect(result.fileString).not.toContain('// data to show user')
		expect(result.fileString).not.toContain('// user actions')
		expect(result.fileString).toContain('// auth required: yes')
	})

	it('handles page with only description', () => {
		const page: Page = {
			description: 'Just a description',
			name: 'DescriptionOnlyPage',
			routePath: '/description-only',
		}

		const result = createRouteText(page)

		expect(result.fileName).toBe('description-only-page.tsx')
		expect(result.fileString).toContain('// description: Just a description')
		expect(result.fileString).not.toContain('// components used in the page')
		expect(result.fileString).not.toContain('// data to show user')
		expect(result.fileString).not.toContain('// user actions')
		expect(result.fileString).not.toContain('// auth required')
	})

	it('handles page with empty description string', () => {
		const page: Page = {
			description: '',
			name: 'EmptyDescriptionPage',
			routePath: '/empty-description',
		}

		const result = createRouteText(page)

		expect(result.fileName).toBe('empty-description-page.tsx')
		expect(result.fileString).not.toContain('// description')
	})
})
