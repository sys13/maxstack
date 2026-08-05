import { render, screen } from '@testing-library/react'
import { describe, expect, it } from 'vitest'
import { createResourceRegistry } from './resource-registry.ts'
import { Breadcrumbs, Forbidden, Menu, NotFound } from './shell.tsx'

function registry() {
	return createResourceRegistry([
		{ name: 'post', icon: '📝' },
		{ name: 'comment' },
	])
}

describe('Menu', () => {
	it('renders one link per accessible resource, highlighting the active one', () => {
		render(<Menu registry={registry()} active="post" />)
		const links = screen.getAllByRole('link')
		expect(links.map((l) => l.textContent)).toEqual(['📝Posts', 'Comments'])
		expect(links[0]).toHaveAttribute('href', '/post')
		expect(links[0]?.className).toContain('font-medium')
	})

	it('drops entries the session cannot read and appends extras', () => {
		render(
			<Menu
				registry={registry()}
				capabilities={{
					comment: { read: false, create: false, update: false, delete: false },
				}}
				extra={[{ name: 'dashboard', label: 'Dashboard', href: '/' }]}
			/>,
		)
		const labels = screen.getAllByRole('link').map((l) => l.textContent)
		expect(labels).toEqual(['📝Posts', 'Dashboard'])
	})
})

describe('Breadcrumbs', () => {
	it('renders a linked trail with the last crumb plain', () => {
		render(
			<Breadcrumbs registry={registry()} resource="post" kind="edit" id="7" />,
		)
		expect(screen.getByRole('link', { name: 'Posts' })).toHaveAttribute(
			'href',
			'/post',
		)
		expect(screen.getByText('Edit')).toBeInTheDocument()
		// "Edit" is the last crumb → not a link.
		expect(screen.queryByRole('link', { name: 'Edit' })).not.toBeInTheDocument()
	})
})

describe('error pages', () => {
	it('NotFound shows 404', () => {
		render(<NotFound />)
		expect(screen.getByText('404')).toBeInTheDocument()
		expect(screen.getByText('Page not found')).toBeInTheDocument()
	})

	it('Forbidden shows 403 and an alert role', () => {
		render(<Forbidden />)
		expect(screen.getByRole('alert')).toBeInTheDocument()
		expect(screen.getByText('403')).toBeInTheDocument()
	})
})
