import { camelCase, kebabCase } from 'es-toolkit'

import { Page } from '../maxstack-parsing/msZod.js'

export function createRouteText(page: Page): {
	fileName: string
	fileString: string
} {
	const routeFileName = kebabCase(page.name) + '.tsx'
	const templateComponents = page.templateComponents
		? page.templateComponents.map(
				(component) => `<Template componentName="${kebabCase(component)}" />`,
			)
		: []

	// Build comment lines only for non-empty values
	const comments = []

	if (page.description) {
		comments.push(`// description: ${page.description}`)
	}

	if (page.components && page.components.length > 0) {
		comments.push(
			`// components used in the page: ${page.components.join(',')}`,
		)
	}

	if (page.infoOnPage && page.infoOnPage.length > 0) {
		comments.push(`// data to show user: ${page.infoOnPage.join(',')}`)
	}

	if (page.userActions && page.userActions.length > 0) {
		comments.push(`// user actions: ${page.userActions.join(',')}`)
	}

	if (page.authRequired !== undefined) {
		comments.push(`// auth required: ${page.authRequired ? 'yes' : 'no'}`)
	}

	const commentSection = comments.length > 0 ? comments.join('\n') + '\n' : ''

	return {
		fileName: routeFileName,
		fileString: `import Template, { registry } from '~/components/templates/template'
import type { Route } from './+types/${kebabCase(page.name)}'

${commentSection}export default function ${camelCase(page.name)}Page({}: Route.ComponentProps ) {
	return (
		<>
			${templateComponents.map((component) => component).join('\n')}
		</>
	)
}`,
	}
}
