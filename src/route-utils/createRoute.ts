import { camelCase, kebabCase } from 'es-toolkit'

import { Page } from '../maxstack-parsing/msZod.js'
import { templates } from '../template-data/templates.js'

export function createRouteText(page: Page): {
	fileName: string
	fileString: string
} {
	const routeFileName = kebabCase(page.name) + '.tsx'
	const templateComponents = page.templateComponents
		? page.templateComponents.map((component) => {
				const templateD = templates[component as keyof typeof templates]
				// eslint-disable-next-line @typescript-eslint/no-unnecessary-condition
				if (templateD?.loaderObj) {
					return `<Template componentName="${component}" props={{ ${templateD.loaderObj} }} />`
				} else {
					return `<Template componentName="${component}" />`
				}
			})
		: []

	// Check if any templateComponents match keys in templates
	const matchingTemplate = page.templateComponents?.find((component) =>
		Object.keys(templates).includes(component),
	)

	// Get template data if there's a match
	const templateData = matchingTemplate
		? templates[matchingTemplate as keyof typeof templates]
		: null

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

	// Build imports - include template imports if there's a match
	let imports = `import Template, { registry } from '~/components/templates/template'
import type { Route } from './+types/${kebabCase(page.name)}'`

	if (templateData?.importsText) {
		imports += `\n${templateData.importsText}`
	}

	// Build the file content
	let fileContent = `${imports}

${commentSection}`

	// Add loader if template has one
	if (templateData?.loaderText) {
		fileContent += `${templateData.loaderText}

`
	}

	// Create function name - convert to camelCase but keep first letter lowercase, then add "Page"
	const functionName =
		camelCase(page.name).charAt(0).toUpperCase() +
		camelCase(page.name).slice(1) +
		'Page'

	fileContent += `export default function ${functionName}({${templateData?.loaderText ? ' loaderData ' : ''}}: Route.ComponentProps ) {`
	fileContent += templateData?.loaderObj
		? `\nconst { ${templateData.loaderObj} } = loaderData`
		: ''
	fileContent += `\n	return (
		<>
			${templateComponents.join('\n')}
		</>
	)
}`

	return {
		fileName: routeFileName,
		fileString: fileContent,
	}
}
